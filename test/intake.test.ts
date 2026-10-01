/**
 * The sequence both entry points run.
 *
 * Until 2026-09-22 there were two: the command line ran OCR and read the votes off the page, the
 * desktop shell did neither, and every test passed because each tested its own path. These tests
 * exercise the sequence itself, which is the only thing that can now be wrong in one place rather
 * than in two.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmLocation, openRecord } from "../src/record/db.js";
import { intake } from "../src/ingest/intake.js";
import { ocrEngine } from "../src/extract/ocr.js";
import { makeScannedPdf } from "./make-pdf.js";

const engine = ocrEngine();

const WITH_A_VOTE = [
  "BOARD PACKET, REGULAR MEETING, March 12, 2026",
  "Item 4.1 Resolution 2026-07 authorises Contract PO-44821 for substation",
  "rebuild work in an amount not to exceed $1,200,000.",
  "The motion carried on a vote of 5-2.",
].join("\n");

function fresh(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  confirmLocation(dir, "the test");
  return { dir, rec: openRecord(dir) };
}

test("intake reads the votes off the page, with no model involved", async () => {
  const { dir, rec } = fresh("pr-intake1-");
  const f = join(dir, "packet.txt");
  writeFileSync(f, WITH_A_VOTE);

  const out = await intake(rec, f, { layer: "public" }); // no model: the votes are code's job
  assert.equal(out.ingest, null, "no model was asked for, so none was used");
  assert.equal(out.votes, 1, "one vote line on the page");

  const row = rec.db
    .prepare("SELECT subject, yes, no FROM votes WHERE document_id = ?")
    .get(out.added.document_id) as { subject: string; yes: number; no: number };
  assert.equal(row.yes, 5);
  assert.equal(row.no, 2);
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("intake reads commitments off the page too, as drafts and never as accepted", async () => {
  const { dir, rec } = fresh("pr-intake6-");
  const f = join(dir, "packet.txt");
  writeFileSync(f, "Item 6. Staff will report on the substation rebuild by December 1, 2026. " +
    "The board discussed the matter at length.");

  const out = await intake(rec, f, { layer: "public" });
  assert.equal(out.commitments, 1, "an undertaking is one; a discussion is not");
  const row = rec.db
    .prepare("SELECT text, due, pairing_state FROM commitments WHERE document_id = ?")
    .get(out.added.document_id) as { text: string; due: string | null; pairing_state: string };
  assert.match(row.text, /Staff will report/);
  assert.equal(row.due, "2026-12-01");
  assert.equal(row.pairing_state, "draft", "nothing here accepts a pairing: that is the person's");
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("intake saves a change record, so the caller never has to remember to", async () => {
  const { dir, rec } = fresh("pr-intake2-");
  const f = join(dir, "packet.txt");
  writeFileSync(f, WITH_A_VOTE);

  const out = await intake(rec, f, { layer: "public" });
  assert.ok(out.change_record_id > 0, "a change record was written, not only computed");
  const saved = rec.db
    .prepare("SELECT COUNT(*) AS n FROM change_records WHERE id = ?")
    .get(out.change_record_id) as { n: number };
  assert.equal(saved.n, 1);
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("reading a document twice replaces the votes rather than doubling them", async () => {
  const { dir, rec } = fresh("pr-intake3-");
  const f = join(dir, "packet.txt");
  writeFileSync(f, WITH_A_VOTE);

  const first = await intake(rec, f, { layer: "public" });
  const again = await intake(rec, f, { layer: "public" });
  assert.equal(again.added.document_id, first.added.document_id, "same digest, same document");
  assert.equal(again.votes, 1);
  const count = rec.db
    .prepare("SELECT COUNT(*) AS n FROM votes WHERE document_id = ?")
    .get(first.added.document_id) as { n: number };
  assert.equal(count.n, 1, "two readings, one vote");
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a page with no text layer is reported, and is NOT silently treated as empty", async () => {
  // OCR has no switch, so the one way a page stays unread is the real one: no engine on this
  // machine. PATH is emptied for this test so `ocrEngine()` finds none, whatever is installed.
  const { dir, rec } = fresh("pr-intake4-");
  const f = join(dir, "scan.pdf");
  writeFileSync(f, await makeScannedPdf(["Item 4.1 Resolution 2026-07", "The motion carried 5-2."]));

  const path = process.env.PATH;
  process.env.PATH = "";
  let out;
  try {
    out = await intake(rec, f, { layer: "public" });
  } finally {
    process.env.PATH = path;
  }
  assert.equal(out.added.pages_with_text, 0);
  assert.equal(out.ocr?.ran, false, "no engine, so nothing claims to have read it");
  assert.deepEqual(out.ocr?.pages_still_unread, [1], "the unread page is NAMED, not reported as none");
  assert.match(out.ocr?.note ?? "", /no OCR engine/);
  assert.equal(out.votes, 0, "an unread page yields no votes, and says so rather than reporting none found");
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("intake OCRs a scanned page and THEN reads its votes, which is the order that matters",
  { skip: !engine.available ? engine.note : false }, async () => {
    const { dir, rec } = fresh("pr-intake5-");
    const f = join(dir, "scan.pdf");
    writeFileSync(f, await makeScannedPdf([
      "BOARD PACKET, REGULAR MEETING, March 12, 2026",
      "Item 4.1 Resolution 2026-07 authorises Contract PO-44821.",
      "The motion carried on a vote of 5-2.",
    ]));

    const out = await intake(rec, f, { layer: "public" });
    assert.ok(out.ocr?.ran, "the engine is installed, so OCR ran");
    assert.equal(out.ocr?.pages_read, 1);
    // This is the assertion that would have failed through the desktop shell before 2026-09-22:
    // no OCR meant no text, and no text meant no vote, on a page that plainly carries one.
    assert.equal(out.votes, 1, "the vote was read from text OCR had just produced");
    rec.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
