/**
 * Retrieval is done by code, before the model is asked anything.
 *
 * Raw passages rank first and claims come second, because a sibling prototype measured plain hybrid
 * retrieval BEATING its own model-extracted evidence layer. Extraction here is a reading of the
 * record, never the index into it.
 *
 * Hybrid from 2026-09-22: keyword first, then whatever the embeddings find that the words missed.
 * **Keyword ranks before vector** for the same reason, and because a word the person actually used is a
 * better reason to show a page than a number is.
 *
 * Retrieval is still unscored against known answer pages. Hybrid retrieval that has never been measured against questions with known
 * answer pages is a design, not a result.
 */
import type Database from "better-sqlite3";
import { isIndexed, nearest } from "./embed.js";

export type Passage = {
  id: string;
  document_id: number;
  filename: string;
  page_no: number;
  text: string;
  meeting: string | null;
  kind: "passage" | "claim";
};

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "was", "were", "are", "what",
  "which", "who", "when", "did", "does", "do", "has", "have", "had", "it", "that", "this", "with",
  "how", "much", "many", "about", "at", "by", "from", "we", "they", "he", "she",
]);

/** An FTS5 query the user did not have to write, built from the words their question carries. */
export function queryFrom(question: string): string {
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9$%.\-\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
  if (!words.length) return "";
  return words.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");
}

type Row = { id: number; document_id: number; page_no: number; text: string; filename: string; meeting: string | null };

/** `documentId` limits the search to one document; without it every document is searched. */
export function retrieve(db: Database.Database, question: string, limit = 8, documentId?: number): Passage[] {
  const q = queryFrom(question);
  if (!q) return [];

  const rows = db
    .prepare<[string, number | null, number | null, number], Row>(
      `SELECT p.id, p.document_id, p.page_no, p.text, d.filename, d.meeting
         FROM pages_fts f
         JOIN pages p ON p.id = f.rowid
         JOIN documents d ON d.id = p.document_id
        WHERE pages_fts MATCH ? AND (? IS NULL OR p.document_id = ?)
        ORDER BY bm25(pages_fts)
        LIMIT ?`,
    )
    .all(q, documentId ?? null, documentId ?? null, limit);

  return rowsToPassages(rows);
}

function rowsToPassages(rows: Row[]): Passage[] {
  return rows.map((r) => ({
    id: `p${r.id}`,
    document_id: r.document_id,
    filename: r.filename,
    page_no: r.page_no,
    text: r.text,
    meeting: r.meeting,
    kind: "passage" as const,
  }));
}

/**
 * What the vector half of retrieval actually did.
 *
 * "used" means it ran. "not indexed" and "no room" are facts about this record and this question.
 * "unavailable" means the embedding model did not answer, and it is the one that must never look
 * like the others: a search that found nothing and a search that never ran print the same empty
 * list and mean opposite things (`CLAUDE.md`, rule 3).
 */
export type VectorHalf =
  | { state: "used"; added: number }
  | { state: "not indexed" }
  | { state: "no room" }
  | { state: "unavailable"; detail: string };

export type Retrieved = { passages: Passage[]; vector: VectorHalf };

/**
 * Keyword first, then what the words missed.
 *
 * The vector half only ever ADDS passages the keyword half did not find, and never reorders it.
 * A question sharing no words with the record found nothing at all before this.
 *
 * **It reports which half ran.** This used to catch the embedding model's failure and return the
 * keyword results with a comment saying that not answering is not a reason to answer nothing. The
 * reasoning is right and the RESULT was indistinguishable from the vector half running and adding
 * nothing, so a broken embedding model looked exactly like a record with no near passage. A public
 * local-assistant project reviewed on 2026-09-22 has the same shape written plainly: its confidence
 * evaluator catches every exception and returns 0.5, a middling judgment, where the honest answer is
 * that it did not judge. This is that, in a politer costume.
 */
export type RetrieveOptions = {
  limit?: number;
  // Named so the "unavailable" branch is reachable from a test. Without it that branch could only
  // be exercised by stopping the model runtime, which is a machine-wide act a test must not take,
  // and a branch no test can reach is the reason it existed unnoticed in the first place.
  model?: string;
  /** Limit both halves to one document. */
  documentId?: number;
};

export async function retrieveHybridReporting(
  db: Database.Database,
  question: string,
  opts: RetrieveOptions = {},
): Promise<Retrieved> {
  const { limit = 8, model, documentId } = opts;
  // Keywords first, but never all of it. A research question is full of common words ("board",
  // "meetings", "items"), and keyword matches filled every slot with standing boilerplate, so the
  // search by meaning reported "no room" and the pages that answered were never offered: the OSE
  // agreement and the solar rate change, on six real agendas (2026-09-30). At least half the room
  // is kept for the search by meaning; the keyword half is still never reordered.
  const wordsCap = isIndexed(db, model) ? Math.ceil(limit / 2) : limit;
  const byWords = retrieve(db, question, wordsCap, documentId);
  if (!isIndexed(db, model)) return { passages: byWords, vector: { state: "not indexed" } };
  const room = limit - byWords.length;
  if (room <= 0) return { passages: byWords, vector: { state: "no room" } };
  const seen = new Set(byWords.map((p) => p.id));

  let near: Array<{ passage_id: number; score: number }> = [];
  try {
    near = await nearest(db, question, limit * 2, model, documentId);
  } catch (e) {
    // The keyword half still stands, and saying so is the difference between degrading and lying.
    return { passages: byWords, vector: { state: "unavailable", detail: (e as Error).message } };
  }
  const get = db.prepare<[number], Row>(
    `SELECT p.id, p.document_id, p.page_no, p.text, d.filename, d.meeting
       FROM pages p JOIN documents d ON d.id = p.document_id WHERE p.id = ?`,
  );
  const extra: Passage[] = [];
  for (const n of near) {
    if (extra.length >= room) break;
    if (seen.has(`p${n.passage_id}`)) continue;
    const row = get.get(n.passage_id);
    if (row) extra.push(...rowsToPassages([row]));
  }
  return { passages: [...byWords, ...extra], vector: { state: "used", added: extra.length } };
}

/** The passages alone, for callers that have no way to show what the vector half did. */
export async function retrieveHybrid(db: Database.Database, question: string, limit = 8): Promise<Passage[]> {
  return (await retrieveHybridReporting(db, question, { limit })).passages;
}

/**
 * A page is too big to put in front of a model whole, so the passage offered is the part of it that
 * carries the question's words, with its offsets kept so the receipt still points at the page.
 */
// 2,400 characters, which is a whole page of most agendas and minutes. At 1,200 the slice cut an
// agenda page's own heading off, and the quote check then dropped true sentences ("the June 18
// meeting") because the date was on the cited page and outside the slice (2026-09-30).
export function narrow(passage: Passage, question: string, chars = 2400): Passage {
  const words = queryFrom(question)
    .split(" OR ")
    .map((w) => w.replace(/"/g, "").toLowerCase());
  const lower = passage.text.toLowerCase();
  let best = 0;
  let bestScore = -1;
  // <= not <: the last candidate used to stop short of the end, so the final stretch of a page was
  // in no window. A page matched on a word in its last 200 characters handed the model a window
  // without that word, and the answer then said the passages do not answer the question.
  for (let i = 0; i <= Math.max(0, passage.text.length - chars); i += 200) {
    const slice = lower.slice(i, i + chars);
    const score = words.reduce((n, w) => n + (slice.includes(w) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return { ...passage, text: passage.text.slice(best, best + chars) };
}
