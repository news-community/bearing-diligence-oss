import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFile } from "../src/extract/extract.js";
import { confirmLocation, openRecord } from "../src/record/db.js";
import { addDocument } from "../src/record/store.js";
import { computeChangeRecord } from "../src/change/compare.js";
import { makePdf } from "./make-pdf.js";

const LINES = [
  "BOARD PACKET, REGULAR MEETING, March 12, 2026",
  "Item 4.1 Resolution 2026-07 authorises Contract PO-44821 for substation",
  "rebuild work in an amount not to exceed $1,200,000.",
  "Resolution 2026-07 was approved on a vote of 5-2.",
];

test("a real PDF is extracted page by page", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-pdf-"));
  const path = join(dir, "packet.pdf");
  writeFileSync(path, makePdf(LINES));
  const x = await extractFile(path);
  assert.equal(x.pages.length, 2, "both pages are seen");
  assert.match(x.tool, /pdfjs/);
  assert.match(x.pages[0]!.text, /Resolution 2026-07/);
  assert.match(x.pages[0]!.text, /\$1,200,000/);
  rmSync(dir, { recursive: true, force: true });
});

test("a PDF page with no text layer is flagged, not treated as empty prose", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-pdf2-"));
  const path = join(dir, "packet.pdf");
  writeFileSync(path, makePdf(LINES));
  const x = await extractFile(path);
  assert.equal(x.pages[0]!.has_text_layer, true);
  assert.equal(x.pages[1]!.has_text_layer, false, "the drawn page carries no text layer");
  rmSync(dir, { recursive: true, force: true });
});

test("the change record over a PDF reports the unread page BEFORE any change", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-pdf3-"));
  confirmLocation(dir, "the test");
  const rec = openRecord(dir);
  const path = join(dir, "packet.pdf");
  writeFileSync(path, makePdf(LINES));
  const added = await addDocument(rec, path, "public");
  assert.equal(added.pages, 2);
  assert.equal(added.pages_with_text, 1);
  const cr = computeChangeRecord(rec.db, added.document_id);
  assert.equal(cr.coverage.complete, false);
  assert.deepEqual(cr.coverage.pages_unread, [2]);
  assert.match(cr.coverage.note, /unread, not unchanged/);
  const ids = cr.changes.filter((c) => c.kind === "new_identifier").map((c) => c.subject);
  assert.ok(ids.includes("resolution:2026-07"), `identifiers from the PDF text: ${JSON.stringify(ids)}`);
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the change record finds a moved figure ACROSS TWO PDFs, which text fixtures alone did not prove", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-pdf4-"));
  confirmLocation(dir, "the test");
  const rec = openRecord(dir);
  const march = join(dir, "march.pdf");
  const april = join(dir, "april.pdf");
  writeFileSync(march, makePdf(LINES));
  writeFileSync(
    april,
    makePdf([
      "BOARD PACKET, REGULAR MEETING, April 9, 2026",
      "Item 4.1 Resolution 2026-07 authorises Contract PO-44821 for substation",
      "rebuild work in an amount not to exceed $1.4 million.",
      "Resolution 2026-07 was approved on a vote of 5-2.",
    ]),
  );
  await addDocument(rec, march, "public");
  const b = await addDocument(rec, april, "public");
  const cr = computeChangeRecord(rec.db, b.document_id);
  const moved = cr.changes.find((c) => c.kind === "moved_figure" && c.subject === "resolution:2026-07|money");
  assert.ok(
    moved,
    "the amount moved from $1,200,000 to $1.4 million on a real PDF. Before the extractor put " +
      "wrapped lines in one paragraph, this found NOTHING and reported no change: " +
      JSON.stringify(cr.changes.map((c) => c.subject)),
  );
  assert.match(moved.then_passage, /1,200,000/);
  assert.match(moved.now_passage, /1\.4 million/);
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the packet's own meeting date in the heading is not reported as a date that MOVED", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-pdf5-"));
  confirmLocation(dir, "the test");
  const rec = openRecord(dir);
  const march = join(dir, "march.pdf");
  const april = join(dir, "april.pdf");
  writeFileSync(march, makePdf(LINES));
  writeFileSync(
    april,
    makePdf([
      "BOARD PACKET, REGULAR MEETING, April 9, 2026",
      "Item 4.1 Resolution 2026-07 authorises Contract PO-44821 for substation",
      "rebuild work in an amount not to exceed $1.4 million.",
    ]),
  );
  await addDocument(rec, march, "public");
  const b = await addDocument(rec, april, "public");
  const cr = computeChangeRecord(rec.db, b.document_id);
  const meetingDate = cr.changes.find((c) => c.kind === "moved_date" && c.now_value.includes("April 9"));
  assert.equal(
    meetingDate, undefined,
    "the meeting moved from March to April; nothing about the contract did. " +
      JSON.stringify(cr.changes.filter((c) => c.kind === "moved_date").map((c) => [c.subject, c.then_value, c.now_value])),
  );
  const money = cr.changes.find((c) => c.kind === "moved_figure" && c.subject === "resolution:2026-07|money");
  assert.ok(money, "the amount still moves, so the heading rule did not silence the real change");
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a page with no text layer is never put in front of the model", async () => {
  // planWindows skips it. Deleting that skip passed every test until this one, which means an
  // empty page could have been sent to the model and counted as read.
  const { planWindows } = await import("../src/ingest/pipeline.js");
  const pages = [
    { page_no: 1, text: "Item 4.1 Resolution 2026-07 authorises work.", has_text_layer: 1 },
    { page_no: 2, text: "", has_text_layer: 0 },
    { page_no: 3, text: "Item 4.2 Tariff Advice No. 118 proposes a rate increase.", has_text_layer: 1 },
  ];
  const windows = planWindows(pages);
  const text = windows.map((w) => w.text).join("");
  assert.ok(text.includes("Resolution 2026-07") && text.includes("Tariff Advice"), "both read pages are in");
  const held = windows.flatMap((w) => w.pages);
  assert.deepEqual(held, [1, 3], "page 2 has no text layer and is not in any window");
  assert.equal(
    windows[0]!.pages.length, 2,
    "the window SPANS pages 1 to 3 and HOLDS two, and coverage counts what it holds: counting the " +
      "span made the model appear to have read a page it never saw",
  );
});
