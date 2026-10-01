/**
 * What management told the board it would do, beside what the record later shows.
 *
 * Two rules. A value is read from the passage, never from a model's
 * sentence. And nothing mechanical can say that a commitment and a later outcome belong together,
 * so a pairing is interpretive synthesis: it is stored as a labeled DRAFT and stays out of the
 * record until the person accepts it, one at a time, with the acceptance recorded.
 */
import type Database from "better-sqlite3";
import { dates, passageAround } from "../change/patterns.js";

export type Commitment = {
  text: string;
  passage: string;
  page_no: number;
  due: string | null;
  start: number;
  end: number;
};

/** Undertakings, not intentions. "Staff will report" is one; "the board discussed" is not. */
const PROMISE =
  /\b((?:staff|management|the general manager|the company|the utility|we|administration)\s+(?:will|shall|is expected to|has committed to|commits to|intends to|agreed to)\s+[^.\n]{8,200})/gi;

/**
 * A sentence can carry two undertakings joined by "and", and the first version of this matched them
 * as ONE: "staff will report monthly and management will deliver a revised schedule". Accepting or
 * rejecting a record that contains two promises is ambiguous, so they are split at the point where
 * a new subject takes up a new modal.
 */
const JOINED = /\s+and\s+(?=(?:staff|management|the general manager|the company|the utility|we|administration)\s+(?:will|shall|is expected to|has committed to|commits to|intends to|agreed to)\b)/i;

export function detectCommitments(text: string, pageNo: number): Commitment[] {
  const out: Commitment[] = [];
  for (const m of text.matchAll(PROMISE)) {
    const whole = (m[1] ?? "").replace(/\s+/g, " ").trim();
    const start = m.index ?? 0;
    const end = start + (m[0]?.length ?? 0);
    const passage = passageAround(text, start, end);
    let cursor = start;
    for (const piece of whole.split(JOINED)) {
      const sentence = piece.trim();
      if (sentence.length < 8) continue;
      const at = text.indexOf(sentence.slice(0, 24), cursor);
      const pieceStart = at === -1 ? start : at;
      const pieceEnd = pieceStart + sentence.length;
      cursor = pieceEnd;
      out.push({
        text: sentence,
        passage,
        page_no: pageNo,
        due: dates(sentence).at(-1)?.iso ?? dates(passage).at(-1)?.iso ?? null,
        start: pieceStart,
        end: pieceEnd,
      });
    }
  }
  return out;
}

export type Pairing = {
  commitment_id: number;
  commitment_text: string;
  commitment_passage: string;
  outcome_passage: string;
  outcome_document_id: number;
  outcome_page: number;
  band: "identifier" | "overlap";
  shared: string[];
};

/**
 * Candidate pairings, by what the two passages SHARE: an identifier, or enough uncommon words.
 * Nothing here decides whether a commitment was kept. The bands are named so the reader can see on what
 * basis a pair was put in front of them, which is the difference between a draft and a verdict.
 */
export function proposePairings(db: Database.Database, minOverlap = 4): Pairing[] {
  const commitments = db
    .prepare<[], { id: number; document_id: number; text: string; passage: string }>(
      "SELECT id, document_id, text, passage FROM commitments WHERE pairing_state = 'draft'",
    )
    .all();
  const later = db
    .prepare<[], { document_id: number; page_no: number; text: string; added_at: string }>(
      `SELECT p.document_id, p.page_no, p.text, d.added_at FROM pages p
         JOIN documents d ON d.id = p.document_id WHERE p.has_text_layer = 1`,
    )
    .all();

  const out: Pairing[] = [];
  for (const c of commitments) {
    const words = new Set(
      c.text.toLowerCase().split(/[^a-z0-9$%.-]+/).filter((w) => w.length > 4),
    );
    for (const p of later) {
      if (p.document_id === c.document_id) continue;
      const lower = p.text.toLowerCase();
      const shared = [...words].filter((w) => lower.includes(w));
      if (shared.length < minOverlap) continue;
      const at = lower.indexOf(shared[0]!);
      out.push({
        commitment_id: c.id,
        commitment_text: c.text,
        commitment_passage: c.passage,
        outcome_passage: passageAround(p.text, at, at + 20),
        outcome_document_id: p.document_id,
        outcome_page: p.page_no,
        band: "overlap",
        shared,
      });
    }
  }
  return out;
}
