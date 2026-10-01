/**
 * Leaving a document out of the record, and letting it back in.
 *
 * Leaving out removes everything the record holds that came from the document: its pages and search
 * index, its claims, refusals, votes, commitments, marks, embeddings and runs (all of which cascade
 * from its row), the passages other documents' change records quoted from it (which do not), and the
 * stored copy of the file. Then the write-ahead log is folded in and the file compacted, so the text
 * leaves the disk rather than only the tables. Only its digest is kept, so the folder does not read
 * it again; including it again forgets the digest and it is read from scratch.
 *
 * What this cannot reach: a backup or filesystem snapshot taken before, and the original file,
 * which belongs to the person and stays in their folder.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Record as OpenRecord } from "./db.js";

export function leaveOut(rec: OpenRecord, digest: string): { removed: boolean } {
  const doc = rec.db.prepare<[string], { id: number; filename: string }>("SELECT id, filename FROM documents WHERE digest = ?").get(digest);
  rec.db.transaction(() => {
    if (doc) {
      rec.db.prepare("DELETE FROM changes WHERE now_document_id = ? OR then_document_id = ?").run(doc.id, doc.id);
      rec.db.prepare("DELETE FROM runs WHERE document_id IS NULL AND filename = ?").run(doc.filename);
      rec.db.prepare("DELETE FROM documents WHERE id = ?").run(doc.id);
    }
    rec.db.prepare("INSERT OR REPLACE INTO left_out (digest, left_out_at) VALUES (?, ?)").run(digest, new Date().toISOString());
  })();
  const raw = join(rec.dir, "raw", digest);
  if (existsSync(raw)) rmSync(raw);
  if (doc) compact(rec);
  return { removed: Boolean(doc) };
}

/**
 * After a delete, make the deleted text leave the disk and not only the tables: fold the search
 * index's segments, write the log into the file, and rebuild the file without the freed pages.
 * Used by leaving a document out and by deleting a saved conversation.
 */
export function compact(rec: OpenRecord): void {
  rec.db.exec("INSERT INTO pages_fts(pages_fts) VALUES('optimize')");
  rec.db.pragma("wal_checkpoint(TRUNCATE)");
  rec.db.exec("VACUUM");
  rec.db.pragma("wal_checkpoint(TRUNCATE)");
}

export function includeAgain(rec: OpenRecord, digest: string): void {
  rec.db.prepare("DELETE FROM left_out WHERE digest = ?").run(digest);
}

export function isLeftOut(rec: OpenRecord, digest: string): boolean {
  return Boolean(rec.db.prepare("SELECT 1 FROM left_out WHERE digest = ?").get(digest));
}
