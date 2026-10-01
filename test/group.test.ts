/**
 * Changes that quote the same two passages are one comparison, carrying every value that differs;
 * a change without a passage pair stays on its own.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Change } from "../src/change/compare.js";
import { groupChanges } from "../src/change/group.js";

const then_passage = "for the period of April 16, 2026, through May 15, 2026.";
const now_passage = "for the period of May 16, 2026, through June 15, 2026.";
const date = (then_value: string, now_value: string): Change => ({
  kind: "moved_date", subject: "resolution:25-04-02|date", then_value, now_value,
  then_document_id: 5, then_page: 2, then_passage, now_document_id: 6, now_page: 2, now_passage, count: 0, meetings: "",
});

test("two date changes quoting the same passages are one comparison with both pairs", () => {
  // Measured 2026-09-30: the June agenda showed this range as two identical "moved date" blocks.
  const g = groupChanges([date("April 16, 2026", "May 16, 2026"), date("May 15, 2026", "June 15, 2026"), date("April 16, 2026", "May 16, 2026")]);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0]!.pairs, [{ then: "April 16, 2026", now: "May 16, 2026" }, { then: "May 15, 2026", now: "June 15, 2026" }]);
});

test("a different passage pair, or a first appearance, is not merged", () => {
  const other = { ...date("May 15, 2026", "June 15, 2026"), now_page: 3 };
  const first: Change = { ...date("", ""), kind: "new_identifier", then_passage: "", then_document_id: null, then_page: null };
  const g = groupChanges([date("April 16, 2026", "May 16, 2026"), other, first]);
  assert.equal(g.length, 3);
  assert.deepEqual(g[2]!.pairs, [], "a first appearance has no values to compare");
});
