/**
 * The meeting brief: for each item in the new packet, what the record already says.
 *
 * It starts from the change record rather than from the packet, which is the whole point of doing
 * the work when a packet arrives. Everything in it is assembled by code from stored passages: the
 * changes touching an item, how often it has come up, and the earlier passages themselves.
 *
 * ITS VALUE TO A READER IS UNMEASURED. The proposal says so and this file says so, because a brief that
 * reads well and helps nobody is the easiest thing here to build by accident.
 */
import type Database from "better-sqlite3";
import { computeChangeRecord, type Change, type Coverage } from "../change/compare.js";

export type BriefItem = {
  subject: string;
  is_new: boolean;
  recurrence: number;
  changes: Change[];
  earlier_passages: Array<{ document_id: number; page_no: number; passage: string }>;
};
export type Brief = { document_id: number; coverage: Coverage; items: BriefItem[] };

export function buildBrief(db: Database.Database, documentId: number): Brief {
  const cr = computeChangeRecord(db, documentId);
  const bySubject = new Map<string, Change[]>();
  for (const c of cr.changes) {
    const subject = c.subject.split("|")[0]!;
    bySubject.set(subject, [...(bySubject.get(subject) ?? []), c]);
  }

  const items: BriefItem[] = [];
  for (const [subject, changes] of [...bySubject.entries()].sort()) {
    const recurrence = changes.find((c) => c.kind === "recurrence")?.count ?? 1;
    const isNew = changes.some((c) => c.kind === "new_identifier");
    const earlier = changes
      .filter((c) => c.then_passage)
      .map((c) => ({ document_id: c.then_document_id ?? 0, page_no: c.then_page ?? 0, passage: c.then_passage }));
    items.push({ subject, is_new: isNew, recurrence, changes, earlier_passages: earlier });
  }
  return { document_id: documentId, coverage: cr.coverage, items };
}

/** Plain text, for a terminal or a printout. Coverage first, every time. */
export function renderBrief(b: Brief): string {
  const lines: string[] = [];
  lines.push("COVERAGE FIRST");
  lines.push(`  ${b.coverage.note}`);
  lines.push("");
  for (const item of b.items) {
    lines.push(`${item.subject}${item.is_new ? "   NEW to the record" : `   seen in ${item.recurrence} documents`}`);
    for (const c of item.changes) {
      if (c.kind === "recurrence" || c.kind === "new_identifier") continue;
      lines.push(`  ${c.kind.replace("_", " ")}: ${c.then_value} -> ${c.now_value}`);
      if (c.then_passage) lines.push(`    then: ${c.then_passage}`);
      if (c.now_passage) lines.push(`    now:  ${c.now_passage}`);
    }
    lines.push("");
  }
  lines.push("Everything above was computed from stored passages. Nothing here is a model's reading.");
  return lines.join("\n");
}
