/**
 * A document's readable name says only what the record supports: a date from the filename or the
 * file, a kind only where the first page names it, and otherwise the filename itself.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { documentLabel } from "../src/ui/doc-label.js";

test("a dated filename and a first page reading AGENDA give the date and the kind", () => {
  const l = documentLabel("2026-03-19_Agenda_BOD-Mtg.pdf", "SACRAMENTO BOARD\nREGULAR MEETING AGENDA\nMarch 19, 2026");
  assert.deepEqual(l, { date: "March 19, 2026", kind: "Agenda", label: "March 19, 2026 · Agenda" });
});

test("minutes that mention the agenda are minutes", () => {
  assert.equal(documentLabel("2026-01-15.pdf", "MINUTES of the regular meeting. Approval of the agenda.").kind, "Minutes");
});

test("a kind named only deep in the page does not count, and the filename stays in the label", () => {
  const l = documentLabel("2026-02-01-packet.pdf", `${"x ".repeat(300)}AGENDA`);
  assert.equal(l.kind, null);
  assert.equal(l.label, "February 1, 2026 · 2026-02-01-packet.pdf");
});

test("with no date in the name, the file's own date; with neither, the filename", () => {
  assert.equal(documentLabel("packet.pdf", null, new Date(2026, 4, 15).getTime()).date, "May 15, 2026");
  assert.equal(documentLabel("packet.pdf").label, "packet.pdf");
});
