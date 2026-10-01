/**
 * Adding a document: the raw bytes are kept by content digest, the text by page.
 *
 * The raw file is always kept. Everything else in the record is derived and can be rebuilt from it,
 * which is what makes a later correction to a pattern or a prompt a re-run rather than a loss.
 */
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Record as OpenRecord } from "./db.js";
import { digestFile } from "../util/digest.js";
import { extractFile } from "../extract/extract.js";

export type AddResult = {
  document_id: number;
  digest: string;
  already_held: boolean;
  pages: number;
  pages_with_text: number;
};

export async function addDocument(
  rec: OpenRecord,
  path: string,
  layer: "public" | "private",
  meeting?: string,
  meetingDate?: string,
): Promise<AddResult> {
  const digest = digestFile(path);
  const existing = rec.db.prepare<[string], { id: number }>("SELECT id FROM documents WHERE digest = ?").get(digest);
  if (existing) {
    const counts = rec.db
      .prepare<[number], { n: number; t: number }>(
        "SELECT COUNT(*) AS n, SUM(has_text_layer) AS t FROM pages WHERE document_id = ?",
      )
      .get(existing.id)!;
    return { document_id: existing.id, digest, already_held: true, pages: counts.n, pages_with_text: counts.t ?? 0 };
  }

  const extraction = await extractFile(path);
  const rawPath = join(rec.dir, "raw", digest);
  if (!existsSync(rawPath)) copyFileSync(path, rawPath);

  const insertDoc = rec.db.prepare(
    `INSERT INTO documents (digest, filename, layer, meeting, meeting_date, added_at, bytes, page_count, extract_tool)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertPage = rec.db.prepare(
    "INSERT INTO pages (document_id, page_no, text, chars, has_text_layer, text_source) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertCoverage = rec.db.prepare(
    `INSERT INTO coverage (document_id, pages_total, pages_with_text, pages_read, windows_total,
       windows_completed, windows_failed) VALUES (?, ?, ?, 0, 0, 0, 0)`,
  );

  const withText = extraction.pages.filter((p) => p.has_text_layer).length;
  // Two adds of the same file can interleave across the extraction above, and the loser used to see
  // a raw "UNIQUE constraint failed: documents.digest" instead of "already held".
  const insertAll = rec.db.transaction(() => {
    const docId = Number(
      insertDoc.run(
        digest,
        extraction.filename,
        layer,
        meeting ?? null,
        meetingDate ?? null,
        new Date().toISOString(),
        extraction.bytes,
        extraction.pages.length,
        extraction.tool,
      ).lastInsertRowid,
    );
    for (const p of extraction.pages) {
      insertPage.run(docId, p.page_no, p.text, p.text.length, p.has_text_layer ? 1 : 0, p.has_text_layer ? "extracted" : "none");
    }
    insertCoverage.run(docId, extraction.pages.length, withText);
    return docId;
  });

  let id: number;
  try {
    id = insertAll();
  } catch (e) {
    if (!/UNIQUE constraint failed: documents.digest/.test((e as Error).message)) throw e;
    const raced = rec.db.prepare<[string], { id: number }>("SELECT id FROM documents WHERE digest = ?").get(digest);
    if (!raced) throw e;
    const counts = rec.db
      .prepare<[number], { n: number; t: number }>(
        "SELECT COUNT(*) AS n, SUM(has_text_layer) AS t FROM pages WHERE document_id = ?",
      )
      .get(raced.id)!;
    return { document_id: raced.id, digest, already_held: true, pages: counts.n, pages_with_text: counts.t ?? 0 };
  }

  return { document_id: id, digest, already_held: false, pages: extraction.pages.length, pages_with_text: withText };
}
