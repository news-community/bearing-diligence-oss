import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmLocation, openRecord } from "../src/record/db.js";
import { addDocument } from "../src/record/store.js";
import { ocrDocument, ocrEngine } from "../src/extract/ocr.js";
import { computeChangeRecord } from "../src/change/compare.js";
import { makeScannedPdf } from "./make-pdf.js";

const engine = ocrEngine();
const LINES = [
  "BOARD PACKET, REGULAR MEETING, March 12, 2026",
  "Item 4.1 Resolution 2026-07 authorises Contract PO-44821",
  "for substation rebuild work in an amount not to",
  "exceed $1,200,000.",
];

test("the OCR engine reports whether it exists rather than being assumed", () => {
  assert.equal(typeof engine.available, "boolean");
  if (!engine.available) assert.match(engine.note, /statement about this machine, not about those pages/);
  else assert.ok(engine.languages.includes("eng"), `languages: ${engine.languages.join(",")}`);
});

test("a scanned page has NO text layer, which extraction reports honestly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-ocr1-"));
  confirmLocation(dir, "the test");
  const rec = openRecord(dir);
  const f = join(dir, "scan.pdf");
  writeFileSync(f, await makeScannedPdf(LINES));
  const added = await addDocument(rec, f, "public");
  assert.equal(added.pages, 1);
  assert.equal(added.pages_with_text, 0, "an image of text is not a text layer");
  const row = rec.db.prepare("SELECT text_source FROM pages WHERE document_id = ?").get(added.document_id) as { text_source: string };
  assert.equal(row.text_source, "none");
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("OCR reads the scanned page, and the record says the text came from OCR", { skip: !engine.available ? engine.note : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-ocr2-"));
  confirmLocation(dir, "the test");
  const rec = openRecord(dir);
  const f = join(dir, "scan.pdf");
  writeFileSync(f, await makeScannedPdf(LINES));
  const added = await addDocument(rec, f, "public");

  const out = await ocrDocument(rec, added.document_id);
  assert.equal(out.pages_attempted, 1);
  assert.equal(out.pages_read, 1, `OCR found nothing: ${out.note}`);

  const row = rec.db.prepare("SELECT text, text_source, ocr_engine, has_text_layer FROM pages WHERE document_id = ?").get(added.document_id) as
    { text: string; text_source: string; ocr_engine: string; has_text_layer: number };
  assert.equal(row.text_source, "ocr");
  assert.match(row.ocr_engine, /tesseract/);
  assert.equal(row.has_text_layer, 0, "the PDF still has no text layer; that fact does not change");
  assert.match(row.text, /Resolution 2026-07/);
  assert.match(row.text, /1,200,000/);
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("running OCR twice does nothing the second time", { skip: !engine.available ? engine.note : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-ocr3-"));
  confirmLocation(dir, "the test");
  const rec = openRecord(dir);
  const f = join(dir, "scan.pdf");
  writeFileSync(f, await makeScannedPdf(LINES));
  const added = await addDocument(rec, f, "public");
  await ocrDocument(rec, added.document_id);
  const again = await ocrDocument(rec, added.document_id);
  assert.equal(again.pages_attempted, 0);
  assert.match(again.note, /no page needed it/);
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("coverage stops calling an OCR page unread, and says what it rests on", { skip: !engine.available ? engine.note : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-ocr4-"));
  confirmLocation(dir, "the test");
  const rec = openRecord(dir);
  const f = join(dir, "scan.pdf");
  writeFileSync(f, await makeScannedPdf(LINES));
  const added = await addDocument(rec, f, "public");

  const before = computeChangeRecord(rec.db, added.document_id);
  assert.deepEqual(before.coverage.pages_unread, [1], "before OCR the page is unread");
  assert.equal(before.changes.length, 0, "and nothing can be said about it");

  await ocrDocument(rec, added.document_id);
  const after = computeChangeRecord(rec.db, added.document_id);
  assert.deepEqual(after.coverage.pages_unread, [], "after OCR it is read");
  assert.deepEqual(after.coverage.pages_by_ocr, [1]);
  assert.match(after.coverage.note, /read by OCR instead/);
  assert.match(after.coverage.note, /machine's reading of pixels/);
  const ids = after.changes.filter((c) => c.kind === "new_identifier").map((c) => c.subject);
  assert.ok(ids.includes("resolution:2026-07"), `identifiers found in OCR text: ${JSON.stringify(ids)}`);
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("an OCR page can be FOUND, which it could not be until 2026-09-22", { skip: !engine.available ? engine.note : false }, async () => {
  const { retrieve } = await import("../src/answer/retrieve.js");
  const dir = mkdtempSync(join(tmpdir(), "pr-ocr5-"));
  confirmLocation(dir, "the test");
  const rec = openRecord(dir);
  const f = join(dir, "scan.pdf");
  writeFileSync(f, await makeScannedPdf(LINES));
  const added = await addDocument(rec, f, "public");

  assert.equal(retrieve(rec.db, "substation rebuild", 5).length, 0, "before OCR there is nothing to find");
  await ocrDocument(rec, added.document_id);
  const hits = retrieve(rec.db, "substation rebuild", 5);
  assert.ok(
    hits.length > 0,
    "the page is in the record and the FTS index did not follow the UPDATE, so the coverage line " +
      "said the reader could rely on a page they could not reach",
  );
  assert.match(hits[0]!.text, /Resolution 2026-07/);
  const embeddable = rec.db
    .prepare("SELECT COUNT(*) AS n FROM pages WHERE document_id = ? AND (has_text_layer = 1 OR text_source = 'ocr')")
    .get(added.document_id) as { n: number };
  assert.equal(embeddable.n, 1, "and the embedder will index it too");
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});
