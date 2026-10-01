/**
 * Text with page numbers, or an honest report that a page had none.
 *
 * A page with no text layer is not skipped and not empty: it is recorded with has_text_layer 0, so
 * the change record can say "unread" rather than "unchanged" about it (docs/design.md, "The change record"; the first
 * case built to fail). OCR is a separate pass that fills those pages in, never a silent fallback.
 */
import { readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Page = { page_no: number; text: string; has_text_layer: boolean };
export type Extraction = { pages: Page[]; tool: string; bytes: number; filename: string };

/** A page break in plain text. Text extraction keeps page breaks unless told not to. */
const FORM_FEED = "\f";

export async function extractFile(path: string): Promise<Extraction> {
  const bytes = readFileSync(path);
  const ext = extname(path).toLowerCase();
  if (ext === ".pdf") return extractPdf(path, bytes);
  return extractText(path, bytes);
}

function extractText(path: string, bytes: Buffer): Extraction {
  const whole = bytes.toString("utf8");
  const parts = whole.includes(FORM_FEED) ? whole.split(FORM_FEED) : [whole];
  const pages = parts.map((text, i) => ({
    page_no: i + 1,
    text,
    has_text_layer: text.trim().length > 0,
  }));
  return { pages, tool: "utf8", bytes: bytes.length, filename: basename(path) };
}

async function extractPdf(path: string, bytes: Buffer): Promise<Extraction> {
  // The legacy build is the one that runs under Node without a DOM.
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const standardFontDataUrl = join(
    dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs"))),
    "..",
    "..",
    "standard_fonts",
  ) + "/";
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    // Every asset is local. A library that fetches its own cmaps or fonts at runtime is a network
    // path that an import check cannot see.
    standardFontDataUrl,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;

  const pages: Page[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push({ page_no: n, text: layout(content.items as any[]), has_text_layer: false });
    pages[pages.length - 1]!.has_text_layer = pages[pages.length - 1]!.text.trim().length > 0;
  }
  return { pages, tool: `pdfjs-dist ${pdfjs.version ?? "unknown"}`, bytes: bytes.length, filename: basename(path) };
}

/**
 * Items into lines, lines into paragraphs.
 *
 * This matters more than it looks. The first version emitted a newline for the vertical gap AND
 * another for the item's own end-of-line, so every wrapped line became its own paragraph. Pairing a
 * figure with the identifier that introduces it is paragraph scoped, so on a PDF the identifier sat
 * in one paragraph and the amount in the next, and the change record found NOTHING while every test
 * on text files passed. A capability that silently reports no change is the failure that matters
 * most here, arriving through the extractor rather than through the model.
 *
 * So: a gap near the usual line spacing is a line break inside a paragraph, and a gap noticeably
 * larger than it is a paragraph break. CALIBRATE: 1.6 is a working assumption from one generated
 * document, and it is the kind of number a real packet will move.
 */
export const PARAGRAPH_GAP_RATIO = 1.6;

function layout(items: any[]): string {
  type Line = { y: number; parts: string[] };
  const lines: Line[] = [];
  for (const item of items) {
    if (typeof item.str !== "string" || item.str === "") continue;
    const y = item.transform?.[5] ?? 0;
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - y) < 2) last.parts.push(item.str);
    else lines.push({ y, parts: [item.str] });
  }
  if (!lines.length) return "";

  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) gaps.push(Math.abs(lines[i - 1]!.y - lines[i]!.y));
  const sorted = [...gaps].sort((a, b) => a - b);
  const typical = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;

  let out = lines[0]!.parts.join("");
  for (let i = 1; i < lines.length; i++) {
    const gap = Math.abs(lines[i - 1]!.y - lines[i]!.y);
    const paragraph = typical > 0 && gap > typical * PARAGRAPH_GAP_RATIO;
    out += (paragraph ? "\n\n" : "\n") + lines[i]!.parts.join("");
  }
  return out;
}
