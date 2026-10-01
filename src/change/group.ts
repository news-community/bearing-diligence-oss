/**
 * Changes that share a passage pair, shown as one comparison.
 *
 * The comparison pairs values by subject, so one date range yields several pairings: on six real
 * agendas the compensation period "April 16 through May 15" against "May 16 through June 15" came
 * out as two "moved date" changes with the same two passages, and a reader saw one change twice with
 * nothing to tell them apart. Grouping by the passages they quote collapses those into one, carrying
 * every value that differs so each can be marked in both passages.
 *
 * Changes without a passage pair (first appearances, recurrences) pass through as groups of one.
 */
import type { Change } from "./compare.js";

export type ChangeGroup<C extends Change = Change> = C & { pairs: Array<{ then: string; now: string }> };

const COMPARED = new Set(["moved_figure", "moved_date"]);

export function groupChanges<C extends Change>(changes: C[]): Array<ChangeGroup<C>> {
  const out: Array<ChangeGroup<C>> = [];
  const byKey = new Map<string, ChangeGroup<C>>();
  for (const c of changes) {
    const pair = { then: c.then_value, now: c.now_value };
    if (!COMPARED.has(c.kind) || !c.then_passage || !c.now_passage) {
      out.push({ ...c, pairs: c.then_value || c.now_value ? [pair] : [] });
      continue;
    }
    const key = [c.kind, c.then_document_id, c.then_page, c.then_passage, c.now_document_id, c.now_page, c.now_passage].join("\u0000");
    const seen = byKey.get(key);
    if (seen) {
      if (!seen.pairs.some((p) => p.then === pair.then && p.now === pair.now)) seen.pairs.push(pair);
      continue;
    }
    const g = { ...c, pairs: [pair] };
    byKey.set(key, g);
    out.push(g);
  }
  return out;
}
