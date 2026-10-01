/**
 * What the gate refused, and who was wrong.
 *
 * "The gate refused 30 claims" and "the model wrote 30 bad claims" are the same sentence until
 * somebody reads them, and on this project's first long run they were different: 28 of the 30 were
 * the gate's own defect. That is why gate rule 1 asks for the refusals to be READ, and why nothing
 * here reports a false-refusal rate over unreviewed rows.
 *
 * The verdicts point in different directions and are never totalled into one number:
 *   absent      the model wrote text the source does not contain
 *   recombined  the model joined two real fragments across a boundary they do not share
 *   ambiguous   the quote is in the source more than once, which is the DOCUMENT's doing
 *   too_short   under this gate's own floor, which is a threshold somebody chose
 *   not_covered the window could not arm its controls, which is the gate declining to judge
 *   other       the runtime failed, which is about neither the model nor the gate
 */
import type Database from "better-sqlite3";

export type Refusal = {
  id: number;
  document_id: number;
  window_no: number;
  claim_text: string;
  quote: string;
  verdict: string;
  reason: string;
  created_at: string;
  reviewed_at: string | null;
  reviewed_verdict: "right" | "wrong" | null;
  reviewed_note: string;
  reviewed_by: "person" | "machine" | null;
};

export type RefusalSummary = {
  document_id: number | null;
  total: number;
  by_verdict: Array<{ verdict: string; n: number; points_at: string }>;
  reviewed: number;
  read_by_a_person: number;
  read_by_machine: number;
  gate_was_right: number;
  gate_was_wrong: number;
  claims_kept: number;
  says: string;
  rate: string;
};

const POINTS_AT: Record<string, string> = {
  absent: "the model: it wrote text the source does not contain",
  recombined: "the model: it joined two real fragments into one quotation",
  ambiguous: "the document: the quote is in it more than once, so it names no single place",
  too_short: "this gate's own floor, which is a number somebody chose",
  not_covered: "this gate declining to judge, because the window could not arm its controls",
};

export function summarise(db: Database.Database, documentId?: number): RefusalSummary {
  const where = documentId ? "WHERE document_id = ?" : "";
  const args = documentId ? [documentId] : [];
  const rows = db
    .prepare<any[], { verdict: string; n: number }>(
      `SELECT verdict, COUNT(*) AS n FROM ledger ${where} GROUP BY verdict ORDER BY n DESC`,
    )
    .all(...args);
  const total = rows.reduce((a, b) => a + b.n, 0);
  const reviewedRows = db
    .prepare<any[], { reviewed_verdict: string; reviewed_by: string; n: number }>(
      `SELECT reviewed_verdict, reviewed_by, COUNT(*) AS n FROM ledger ${where ? where + " AND" : "WHERE"} reviewed_verdict IS NOT NULL GROUP BY reviewed_verdict, reviewed_by`,
    )
    .all(...args);
  const sum = (f: (r: { reviewed_verdict: string; reviewed_by: string }) => boolean) =>
    reviewedRows.filter(f).reduce((a, b) => a + b.n, 0);
  const right = sum((r) => r.reviewed_verdict === "right");
  const wrong = sum((r) => r.reviewed_verdict === "wrong");
  const byPerson = sum((r) => r.reviewed_by === "person");
  const byMachine = sum((r) => r.reviewed_by === "machine");
  const reviewed = right + wrong;
  const kept = db
    .prepare<any[], { n: number }>(`SELECT COUNT(*) AS n FROM claims ${where}`)
    .get(...args)!.n;

  const says =
    total === 0
      ? "Nothing was refused. That is a statement about this run, and a gate that has only ever agreed has not been shown to work."
      : `${total} refused against ${kept} kept.`;

  // A machine's reading is a draft. Reading the refusals is a person's job, for the same reason an
  // interpretive synthesis stays out of the record until the person accepts it: the tool checking its own gate
  // with another of its own instruments is the same lens nodding at itself.
  const rate =
    byPerson === 0 && byMachine > 0
      ? `Read by this tool's own second check, not by a person: ${byMachine} of ${total}, and it ` +
        `found the gate ${wrong === 0 ? "right every time" : `WRONG ${wrong} time(s)`}. ` +
        `That is a draft. Gate rule 1 asks for a person, because a tool checking its own gate with ` +
        `another of its own instruments is the same lens nodding at itself.`
      : reviewed === 0
      ? "NOT A RATE YET. Nobody has read these, so it is unknown whether they are the model's errors or the gate's."
      : wrong === 0
        ? `Of ${reviewed} read so far (${byPerson} by a person), the gate was right every time.`
        : `Of ${reviewed} read so far, the gate was WRONG ${wrong} time(s): ${Math.round((wrong / reviewed) * 100)}% of what it refused was good.` +
          (reviewed < total ? ` ${total - reviewed} have not been read.` : "");

  return {
    document_id: documentId ?? null,
    total,
    by_verdict: rows.map((r) => ({ verdict: r.verdict, n: r.n, points_at: POINTS_AT[r.verdict] ?? "the runtime, which is about neither" })),
    reviewed,
    read_by_a_person: byPerson,
    read_by_machine: byMachine,
    gate_was_right: right,
    gate_was_wrong: wrong,
    claims_kept: kept,
    says,
    rate,
  };
}

export function listRefusals(db: Database.Database, documentId?: number, onlyUnread = false, limit = 50): Refusal[] {
  const clauses: string[] = [];
  const args: any[] = [];
  if (documentId) {
    clauses.push("document_id = ?");
    args.push(documentId);
  }
  if (onlyUnread) clauses.push("reviewed_verdict IS NULL");
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db
    .prepare<any[], Refusal>(
      `SELECT id, document_id, window_no, claim_text, quote, verdict, reason, created_at,
              reviewed_at, reviewed_verdict, reviewed_note, reviewed_by
         FROM ledger ${where} ORDER BY reviewed_verdict IS NOT NULL, id LIMIT ?`,
    )
    .all(...args, limit);
}

/** A person's judgment on one refusal. Nothing else writes these columns. */
export function review(
  db: Database.Database,
  id: number,
  verdict: "right" | "wrong",
  note = "",
  by: "person" | "machine" = "person",
): void {
  db.prepare(
    "UPDATE ledger SET reviewed_at = ?, reviewed_verdict = ?, reviewed_note = ?, reviewed_by = ? WHERE id = ?",
  ).run(new Date().toISOString(), verdict, note, by, id);
}
