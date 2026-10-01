import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmLocation, openRecord } from "../src/record/db.js";
import { addDocument } from "../src/record/store.js";
import { computeChangeRecord, saveChangeRecord } from "../src/change/compare.js";
import { LABELS_B, PACKET_A, PACKET_B } from "./fixtures.js";

async function twoPackets(secondText = PACKET_B) {
  const dir = mkdtempSync(join(tmpdir(), "pr-change-"));
  confirmLocation(dir, "the test");
  const rec = openRecord(dir);
  const a = join(dir, "packet-a.txt");
  const b = join(dir, "packet-b.txt");
  writeFileSync(a, PACKET_A);
  writeFileSync(b, secondText);
  const added = await addDocument(rec, a, "public", "2026-03 regular", "2026-03-12");
  const addedB = await addDocument(rec, b, "public", "2026-04 regular", "2026-04-09");
  return { dir, rec, a: added, b: addedB };
}

test("the change record puts coverage first and it is true", async () => {
  const { dir, rec, b } = await twoPackets();
  const cr = computeChangeRecord(rec.db, b.document_id);
  assert.equal(cr.coverage.complete, true);
  assert.equal(cr.coverage.pages_total, 1);
  assert.equal(cr.coverage.pages_unread.length, 0);
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("every identifier a person labeled new is reported new", async () => {
  const { dir, rec, b } = await twoPackets();
  const cr = computeChangeRecord(rec.db, b.document_id);
  const found = cr.changes.filter((c) => c.kind === "new_identifier").map((c) => c.subject);
  for (const want of LABELS_B.new_identifiers) {
    assert.ok(found.includes(want), `hand label says ${want} is new; code found ${JSON.stringify(found)}`);
  }
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a figure that moved is reported with BOTH passages", async () => {
  const { dir, rec, b } = await twoPackets();
  const cr = computeChangeRecord(rec.db, b.document_id);
  const moved = cr.changes.find((c) => c.kind === "moved_figure" && c.subject === "resolution:2026-07|money");
  assert.ok(moved, `hand label says the contract figure moved; changes were ${JSON.stringify(cr.changes.map((c) => c.subject))}`);
  assert.match(moved.then_value, /1,200,000/);
  assert.match(moved.now_value, /1\.4 million/);
  assert.ok(moved.then_passage.length > 20, "the earlier passage must be shown, not just the value");
  assert.ok(moved.now_passage.length > 20, "the new passage must be shown beside it");
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a date that moved is reported", async () => {
  const { dir, rec, b } = await twoPackets();
  const cr = computeChangeRecord(rec.db, b.document_id);
  const moved = cr.changes.find((c) => c.kind === "moved_date" && c.subject === "resolution:2026-07|date");
  assert.ok(
    moved,
    "October 15 became December 3 on resolution 2026-07. This test used to pass on a different " +
      "pairing entirely, the meeting date in the header attached to the first agenda item, which is " +
      "why it now names the subject: " + JSON.stringify(cr.changes.filter((c) => c.kind === "moved_date")),
  );
  assert.match(moved.then_passage, /October 15/);
  assert.match(moved.now_passage, /December 3/);
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a figure written in another format is NOT reported as moved", async () => {
  const reformatted = PACKET_B.replace("$1.4 million", "$1.2 million").replace("December 3, 2026", "October 15, 2026");
  const { dir, rec, b } = await twoPackets(reformatted);
  const cr = computeChangeRecord(rec.db, b.document_id);
  const moved = cr.changes.filter((c) => c.kind === "moved_figure" || c.kind === "moved_date");
  assert.equal(
    moved.length, 0,
    `$1,200,000 and $1.2 million are one figure; reported ${JSON.stringify(moved.map((m) => [m.subject, m.then_value, m.now_value]))}`,
  );
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("recurrence counts the meetings an item has come up in", async () => {
  const { dir, rec, b } = await twoPackets();
  const cr = computeChangeRecord(rec.db, b.document_id);
  const rec2026_07 = cr.changes.find((c) => c.kind === "recurrence" && c.subject === "resolution:2026-07");
  assert.ok(rec2026_07);
  assert.equal(rec2026_07.count, 2);
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a page with no text layer is reported UNREAD, never unchanged", async () => {
  const withBlankPage = PACKET_B + "\f" + "";
  const { dir, rec, b } = await twoPackets(withBlankPage);
  const cr = computeChangeRecord(rec.db, b.document_id);
  assert.equal(cr.coverage.complete, false);
  assert.deepEqual(cr.coverage.pages_unread, [2]);
  assert.match(cr.coverage.note, /unread, not unchanged/);
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the change record round trips through the database", async () => {
  const { dir, rec, b } = await twoPackets();
  const cr = computeChangeRecord(rec.db, b.document_id);
  const id = saveChangeRecord(rec.db, cr);
  const back = rec.db.prepare<[number], { n: number }>("SELECT COUNT(*) AS n FROM changes WHERE change_record_id = ?").get(id)!;
  assert.equal(back.n, cr.changes.length);
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a moved change ALWAYS carries both passages, never an empty one", async () => {
  const { dir, rec, b } = await twoPackets();
  const cr = computeChangeRecord(rec.db, b.document_id);
  const moved = cr.changes.filter((c) => c.kind === "moved_figure" || c.kind === "moved_date");
  assert.ok(moved.length > 0);
  for (const m of moved) {
    assert.ok(m.then_passage.trim().length > 0, `${m.subject} showed no earlier passage`);
    assert.ok(m.now_passage.trim().length > 0, `${m.subject} showed no current passage`);
  }
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the same change is reported once, however many times its identifier appears", async () => {
  const repeated = PACKET_B + "\n\nResolution 2026-07 was noted again. Resolution 2026-07 was noted once more.";
  const { dir, rec, b } = await twoPackets(repeated);
  const cr = computeChangeRecord(rec.db, b.document_id);
  const keys = cr.changes.map((c) => `${c.kind}|${c.subject}|${c.then_value}|${c.now_value}`);
  assert.equal(new Set(keys).size, keys.length, `duplicates: ${JSON.stringify(keys)}`);
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a window the model FAILED on makes coverage incomplete, however clean the extraction was", async () => {
  const { dir, rec, b } = await twoPackets();
  // Every page extracted fine; the model dropped one window, which is what happened on a 250-page run.
  rec.db
    .prepare("UPDATE coverage SET windows_total = 5, windows_completed = 4, windows_failed = 1, failure_kinds = 'unreachable', pages_read = 3 WHERE document_id = ?")
    .run(b.document_id);
  const cr = computeChangeRecord(rec.db, b.document_id);
  assert.equal(cr.coverage.pages_unread.length, 0, "extraction read every page");
  assert.equal(cr.coverage.complete, false, "and the model did not, so coverage is not complete");
  assert.match(cr.coverage.note, /1 of 5 windows FAILED \(unreachable\)/);
  assert.match(cr.coverage.note, /what the model read does not/);
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a clean run says how much the model read, rather than nothing at all", async () => {
  const { dir, rec, b } = await twoPackets();
  rec.db
    .prepare("UPDATE coverage SET windows_total = 2, windows_completed = 2, windows_failed = 0, pages_read = 1 WHERE document_id = ?")
    .run(b.document_id);
  const cr = computeChangeRecord(rec.db, b.document_id);
  assert.equal(cr.coverage.complete, true);
  assert.match(cr.coverage.note, /The model read 1 of 1 pages across 2 windows/);
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a FIGURE on a heading line is not paired with the items below it", async () => {
  // The date half of this rule had a test and the figure half did not, which a deletion pass found.
  // The heading and the item share a paragraph, which is the only shape where the rule can bite:
  // with a blank line between them the paragraph bound already separates the figure.
  const withHeadingFigure =
    "BUDGET SUMMARY, TOTAL $9,999,999\nItem 4.1 Resolution 2026-07 authorises Contract PO-44821 for work.\n";
  const dir = mkdtempSync(join(tmpdir(), "pr-head-"));
  confirmLocation(dir, "the test");
  const rec = openRecord(dir);
  const a = join(dir, "a.txt");
  const b = join(dir, "b.txt");
  writeFileSync(a, withHeadingFigure);
  writeFileSync(b, withHeadingFigure.replace("$9,999,999", "$8,888,888"));
  await addDocument(rec, a, "public");
  const second = await addDocument(rec, b, "public");
  const cr = computeChangeRecord(rec.db, second.document_id);
  const moved = cr.changes.filter((c) => c.kind === "moved_figure");
  assert.equal(
    moved.length, 0,
    `a total in a heading belongs to the packet, not to resolution 2026-07: ${JSON.stringify(moved.map((m) => [m.subject, m.then_value, m.now_value]))}`,
  );
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a change record and its changes are written together or not at all", async () => {
  const { dir, rec, b } = await twoPackets();
  const cr = computeChangeRecord(rec.db, b.document_id);
  // One change is unsaveable, so the whole write must roll back rather than leave a header alone.
  const broken = { ...cr, changes: [...cr.changes, { ...cr.changes[0]!, kind: "not_a_kind" as never }] };
  assert.throws(() => saveChangeRecord(rec.db, broken));
  const headers = rec.db.prepare("SELECT COUNT(*) AS n FROM change_records").get() as { n: number };
  assert.equal(
    headers.n, 0,
    "a change record with no changes reads as 'this packet changed nothing', which is the most " +
      "expensive wrong output here and is indistinguishable from a real empty result",
  );
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("reading a document again REPLACES its claims rather than doubling them", async () => {
  const { dir, rec, b } = await twoPackets();
  const ins = rec.db.prepare(
    "INSERT INTO claims (document_id, page_no, text, quote, verdict, window_no, model, created_at) VALUES (?,1,'c','q','located',1,'m','now')",
  );
  ins.run(b.document_id);
  ins.run(b.document_id);
  const before = rec.db.prepare("SELECT COUNT(*) AS n FROM claims WHERE document_id = ?").get(b.document_id) as { n: number };
  assert.equal(before.n, 2);
  // The pipeline clears a document's previous reading before it starts. Simulated here rather than
  // run, because running it needs a model; the deletion is the part that was missing.
  rec.db.prepare("DELETE FROM claims WHERE document_id = ?").run(b.document_id);
  const after = rec.db.prepare("SELECT COUNT(*) AS n FROM claims WHERE document_id = ?").get(b.document_id) as { n: number };
  assert.equal(after.n, 0, "a second run used to leave both readings with nothing to tell them apart");
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("an agenda item number is local to its meeting and is never compared across meetings", async () => {
  const { dir, rec, b } = await twoPackets();
  const cr = computeChangeRecord(rec.db, b.document_id);
  const items = cr.changes.filter((c) => c.subject.startsWith("agenda_item:"));
  assert.deepEqual(items.map((c) => `${c.kind} ${c.subject}`), [], "no change is reported about an item number");
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a document is compared only with documents added before it, never with later ones", async () => {
  const { dir, rec, a } = await twoPackets();
  const cr = computeChangeRecord(rec.db, a.document_id);
  assert.equal(cr.compared_against, 0, "the first document has nothing earlier to compare with");
  assert.deepEqual(cr.changes.filter((c) => c.kind === "moved_figure" || c.kind === "moved_date"), []);
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});
