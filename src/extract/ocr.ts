/**
 * Reading a page that has no text layer, by rendering it and asking tesseract what it says.
 *
 * A SEPARATE PASS, never a silent fallback inside extraction: a page with no text is reported
 * unread, and OCR is the thing that later fills it in. If it fails, or tesseract is not installed,
 * the page stays unread and says so, because "we could not read it" and "there is nothing there"
 * are the two claims this whole project exists to keep apart.
 *
 * **OCR text is weaker evidence and stays labelled as such.** A quote located in OCR text is
 * located in a machine's reading of pixels, so `text_source` records it and everything downstream
 * can say so. The page's `has_text_layer` stays 0, because that is the truth about the PDF.
 *
 * Licences, which decided the shape: tesseract is Apache-2.0, and the
 * page is rendered with pdf.js and a MIT canvas. Poppler is GPL and PyMuPDF is AGPL, so neither is
 * used even though both are on this machine.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Record as OpenRecord } from "../record/db.js";

export type OcrOutcome = {
  engine: string;
  pages_attempted: number;
  pages_read: number;
  pages_still_unread: number[];
  note: string;
};

/** Which engine is here, if any. An engine that is absent is said, never assumed. */
export function ocrEngine(): { available: boolean; version: string; languages: string[]; note: string } {
  try {
    const version = String(execFileSync("tesseract", ["--version"], { encoding: "utf8" })).split("\n")[0]!.trim();
    const langs = String(execFileSync("tesseract", ["--list-langs"], { encoding: "utf8" }))
      .split("\n")
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean);
    return { available: true, version, languages: langs, note: `${version}, languages: ${langs.join(", ")}` };
  } catch {
    return {
      available: false,
      version: "",
      languages: [],
      note: "no OCR engine is installed on this machine, so pages with no text layer stay unread. That is a statement about this machine, not about those pages.",
    };
  }
}

/**
 * The document is opened ONCE for the whole pass.
 *
 * It used to be opened per page, so a 250-page scanned packet re-parsed the whole PDF 250 times and
 * leaked a worker each time. The font pinning matches extraction's, because rendering is the path
 * that actually needs standard fonts and it was the path that omitted them.
 */
async function openForRender(pdfBytes: Buffer): Promise<{ doc: any; canvasMod: any }> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const canvasMod: any = await import("@napi-rs/canvas");
  const standardFontDataUrl =
    join(dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs"))), "..", "..", "standard_fonts") + "/";
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdfBytes),
    standardFontDataUrl,
    useWorkerFetch: false,
    isEvalSupported: false,
  }).promise;
  return { doc, canvasMod };
}

async function renderPage(doc: any, canvasMod: any, pageNo: number, scale: number): Promise<Buffer> {
  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale });
  const canvas = canvasMod.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx as any, viewport }).promise;
  return canvas.toBuffer("image/png");
}

/** CALIBRATE. 2.0 is a working guess at what a scanned packet needs; a real one will move it. */
export const RENDER_SCALE = 2.0;

export async function ocrDocument(
  rec: OpenRecord,
  documentId: number,
  scale = RENDER_SCALE,
): Promise<OcrOutcome> {
  const engine = ocrEngine();
  const unread = rec.db
    .prepare<[number], { page_no: number }>(
      "SELECT page_no FROM pages WHERE document_id = ? AND has_text_layer = 0 AND text_source != 'ocr' ORDER BY page_no",
    )
    .all(documentId);

  if (!engine.available) {
    return {
      engine: "",
      pages_attempted: 0,
      pages_read: 0,
      pages_still_unread: unread.map((u) => u.page_no),
      note: engine.note,
    };
  }
  if (!unread.length) {
    return { engine: engine.version, pages_attempted: 0, pages_read: 0, pages_still_unread: [], note: "no page needed it" };
  }

  const doc = rec.db
    .prepare<[number], { digest: string; filename: string }>("SELECT digest, filename FROM documents WHERE id = ?")
    .get(documentId);
  if (!doc) throw new Error(`no document ${documentId}`);
  const raw = readFileSync(join(rec.dir, "raw", doc.digest));

  const update = rec.db.prepare(
    "UPDATE pages SET text = ?, chars = ?, text_source = 'ocr', ocr_engine = ? WHERE document_id = ? AND page_no = ?",
  );
  const work = mkdtempSync(join(tmpdir(), "pr-ocr-"));
  let read = 0;
  const stillUnread: number[] = [];
  const broke: string[] = [];
  let opened: { doc: any; canvasMod: any } | null = null;
  try {
    try {
      opened = await openForRender(raw);
    } catch (e) {
      return {
        engine: engine.version,
        pages_attempted: 0,
        pages_read: 0,
        pages_still_unread: unread.map((u) => u.page_no),
        note: `the document could not be opened for rendering, so nothing was attempted: ${(e as Error).message}`,
      };
    }
    for (const { page_no } of unread) {
      let text = "";
      try {
        const png = await renderPage(opened.doc, opened.canvasMod, page_no, scale);
        const image = join(work, `p${page_no}.png`);
        writeFileSync(image, png);
        text = String(execFileSync("tesseract", [image, "stdout", "--psm", "1"], { encoding: "utf8" })).trim();
      } catch (e) {
        // A break is not a finding. Rendering failing, the canvas being absent, tesseract crashing
        // and a page genuinely carrying no readable text all used to arrive as the same sentence:
        // "N produced nothing and stay unread", which is a statement about the pages.
        broke.push(`page ${page_no}: ${(e as Error).message.split("\n")[0]}`);
        stillUnread.push(page_no);
        continue;
      }
      if (text.length > 0) {
        update.run(text, text.length, engine.version, documentId, page_no);
        read++;
      } else {
        stillUnread.push(page_no);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
    try {
      await opened?.doc?.destroy?.();
    } catch {
      /* closing a document that failed to open is not a finding either */
    }
  }
  const quiet = stillUnread.length - broke.length;

  return {
    engine: engine.version,
    pages_attempted: unread.length,
    pages_read: read,
    pages_still_unread: stillUnread,
    note:
      `${read} of ${unread.length} page(s) with no text layer were read by OCR. ` +
      `Their text is a machine's reading of pixels and is recorded as such` +
      (quiet > 0 ? `, ${quiet} carried no readable text and stay unread` : "") +
      (broke.length
        ? `, and ${broke.length} FAILED rather than came back empty: ${broke.slice(0, 3).join("; ")}`
        : "") +
      ".",
  };
}
