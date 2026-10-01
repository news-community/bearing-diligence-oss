/**
 * Embeddings, so a question that shares no words with the record can still find it.
 *
 * Two rules shape this. **Raw passages rank first**, because a sibling
 * prototype measured plain hybrid retrieval beating its own model-extracted evidence layer. And
 * relatedness is not veracity: a near vector is a reason to show a passage, never a reason to
 * assert anything, which is why nothing here feeds a score into an answer.
 *
 * The vectors live in an ordinary column and are searched by reading them. See schema.ts for why
 * that is the version one shape rather than a loadable extension.
 */
import type Database from "better-sqlite3";
import { embedTexts } from "../harness/model.js";

export const EMBED_MODEL = "nomic-embed-text";

export async function embed(texts: string[], model = EMBED_MODEL): Promise<number[][]> {
  const r = await embedTexts(texts, model);
  if (!r.ok) throw new Error(`${r.failure.kind}: ${r.failure.detail}`);
  return r.vectors;
}

const toBlob = (v: number[]) => Buffer.from(new Float32Array(v).buffer);
const fromBlob = (b: Buffer) => Array.from(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4));

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Index every page of a document. Idempotent: a page already embedded by this model is skipped. */
export async function indexDocument(
  db: Database.Database,
  documentId: number,
  model = EMBED_MODEL,
  batch = 16,
): Promise<{ embedded: number; already: number }> {
  const pages = db
    .prepare<[number, string], { id: number; text: string }>(
      `SELECT p.id, p.text FROM pages p
        WHERE p.document_id = ? AND (p.has_text_layer = 1 OR p.text_source = 'ocr')
          AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.kind = 'passage' AND e.ref_id = p.id AND e.model = ?)`,
    )
    .all(documentId, model);
  const total = db
    .prepare<[number], { n: number }>("SELECT COUNT(*) AS n FROM pages WHERE document_id = ? AND (has_text_layer = 1 OR text_source = 'ocr')")
    .get(documentId)!.n;

  const insert = db.prepare(
    "INSERT OR REPLACE INTO embeddings (kind, ref_id, document_id, model, dims, vector) VALUES ('passage', ?, ?, ?, ?, ?)",
  );
  let done = 0;
  for (let i = 0; i < pages.length; i += batch) {
    const slice = pages.slice(i, i + batch);
    const vectors = await embed(slice.map((p) => p.text.slice(0, 8000)), model);
    const tx = db.transaction(() => {
      slice.forEach((p, j) => {
        const v = vectors[j];
        if (!v) return;
        insert.run(p.id, documentId, model, v.length, toBlob(v));
        done++;
      });
    });
    tx();
  }
  return { embedded: done, already: total - pages.length };
}

export type Near = { passage_id: number; score: number };

/** Nearest stored passages. Reads every vector, which is fast enough and has no extension to sign. */
export async function nearest(
  db: Database.Database,
  question: string,
  limit = 8,
  model: string = EMBED_MODEL,
  documentId?: number,
): Promise<Near[]> {
  const rows = db
    .prepare<[string, number | null, number | null], { ref_id: number; vector: Buffer }>(
      "SELECT ref_id, vector FROM embeddings WHERE kind = 'passage' AND model = ? AND (? IS NULL OR document_id = ?)",
    )
    .all(model, documentId ?? null, documentId ?? null);
  if (!rows.length) return [];
  const [q] = await embed([question], model);
  if (!q) return [];
  return rows
    .map((r) => ({ passage_id: r.ref_id, score: cosine(q, fromBlob(r.vector)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function isIndexed(db: Database.Database, model: string = EMBED_MODEL): boolean {
  return (
    (db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM embeddings WHERE model = ?").get(model)?.n ?? 0) > 0
  );
}
