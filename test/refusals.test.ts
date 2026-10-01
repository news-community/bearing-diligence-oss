import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmLocation, openRecord } from "../src/record/db.js";
import { addDocument } from "../src/record/store.js";
import { listRefusals, review, summarise } from "../src/quote/refusals.js";
import { recheckRefusals } from "../src/ingest/pipeline.js";
import { PACKET_A } from "./fixtures.js";

async function withLedger() {
  const dir = mkdtempSync(join(tmpdir(), "pr-ref-"));
  confirmLocation(dir, "the test");
  const rec = openRecord(dir);
  const f = join(dir, "packet.txt");
  writeFileSync(f, PACKET_A);
  const added = await addDocument(rec, f, "public");
  const ins = rec.db.prepare(
    "INSERT INTO ledger (document_id, window_no, claim_text, quote, verdict, reason, created_at) VALUES (?,?,?,?,?,?,?)",
  );
  const now = new Date().toISOString();
  ins.run(added.document_id, 1, "a claim", "a quote that is not there", "absent", "the span is not in the source", now);
  ins.run(added.document_id, 1, "another", "a repeated line", "ambiguous", "appears 2 times", now);
  ins.run(added.document_id, 2, "third", "a repeated line", "ambiguous", "appears 2 times", now);
  ins.run(added.document_id, 2, "fourth", "short", "too_short", "under the floor", now);
  return { dir, rec, documentId: added.document_id };
}
const cleanupRef = (dir: string, rec: any) => {
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
};

test("an unread refusal count is NOT presented as a rate", async () => {
  const { dir, rec, documentId } = await withLedger();
  const s = summarise(rec.db, documentId);
  assert.equal(s.total, 4);
  assert.match(s.rate, /NOT A RATE YET/);
  assert.match(s.rate, /whether they are the model's errors or the gate's/);
  cleanupRef(dir, rec);
});

test("the verdicts are not totalled into one number, because they point different ways", async () => {
  const { dir, rec, documentId } = await withLedger();
  const s = summarise(rec.db, documentId);
  const absent = s.by_verdict.find((v) => v.verdict === "absent")!;
  const ambiguous = s.by_verdict.find((v) => v.verdict === "ambiguous")!;
  const short = s.by_verdict.find((v) => v.verdict === "too_short")!;
  assert.match(absent.points_at, /the model/);
  assert.match(ambiguous.points_at, /the document/);
  assert.match(short.points_at, /this gate's own floor/);
  cleanupRef(dir, rec);
});

test("once a person reads them, the rate is reported and says what it is over", async () => {
  const { dir, rec, documentId } = await withLedger();
  const rows = listRefusals(rec.db, documentId);
  review(rec.db, rows[0]!.id, "right", "the date really is not in the packet");
  review(rec.db, rows[1]!.id, "wrong", "the quote is there, the gate cut it short");
  const s = summarise(rec.db, documentId);
  assert.equal(s.reviewed, 2);
  assert.equal(s.gate_was_wrong, 1);
  assert.match(s.rate, /the gate was WRONG 1 time/);
  assert.match(s.rate, /2 have not been read/);
  cleanupRef(dir, rec);
});

test("a gate that refused nothing says so, and says that proves nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-ref2-"));
  confirmLocation(dir, "the test");
  const rec = openRecord(dir);
  const s = summarise(rec.db);
  assert.equal(s.total, 0);
  assert.match(s.says, /has only ever agreed has not been shown to work/);
  cleanupRef(dir, rec);
});

test("unread refusals come first, so the reading has somewhere to start", async () => {
  const { dir, rec, documentId } = await withLedger();
  const rows = listRefusals(rec.db, documentId);
  review(rec.db, rows[0]!.id, "right");
  const after = listRefusals(rec.db, documentId);
  assert.equal(after[0]!.reviewed_verdict, null, "an unread one is at the top");
  assert.equal(after[after.length - 1]!.reviewed_verdict, "right");
  assert.equal(listRefusals(rec.db, documentId, true).length, 3);
  cleanupRef(dir, rec);
});

test("a machine reading is a draft and never the rate gate rule 1 asks for", async () => {
  const { dir, rec, documentId } = await withLedger();
  for (const r of listRefusals(rec.db, documentId)) {
    review(rec.db, r.id, "right", "cross-checked by a second instrument", "machine");
  }
  const s = summarise(rec.db, documentId);
  assert.equal(s.read_by_machine, 4);
  assert.equal(s.read_by_a_person, 0);
  assert.match(s.rate, /not by a person/);
  assert.match(s.rate, /same lens nodding at itself/);
  cleanupRef(dir, rec);
});

test("once a person reads one, the rate says how many of the readings were theirs", async () => {
  const { dir, rec, documentId } = await withLedger();
  const rows = listRefusals(rec.db, documentId);
  review(rec.db, rows[0]!.id, "right", "read it", "machine");
  review(rec.db, rows[1]!.id, "right", "read it myself", "person");
  const s = summarise(rec.db, documentId);
  assert.equal(s.read_by_a_person, 1);
  assert.match(s.rate, /1 by a person/);
  cleanupRef(dir, rec);
});

test("a refusal the fixed locator finds becomes a claim, once; an absent or reviewed one is left alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-recheck-"));
  confirmLocation(dir, "the test");
  const rec = openRecord(dir);
  const f = join(dir, "packet.txt");
  const address = "https://www.example.org/Corporate/About-us/Board-Meetings/Watch-or-Listen-online";
  writeFileSync(f, PACKET_A + "\nArchives of meetings are at https://www.example.org/Corporate/About-us/Board-Meetings/Watch-or-\nListen-online\n");
  const { document_id } = await addDocument(rec, f, "public");
  const ins = rec.db.prepare(
    "INSERT INTO ledger (document_id, window_no, claim_text, quote, verdict, reason, created_at, reviewed_verdict) VALUES (?,?,?,?,?,?,?,?)",
  );
  const now = new Date().toISOString();
  ins.run(document_id, 1, "Meetings are archived online.", address, "absent", "the span is not in the source", now, null);
  ins.run(document_id, 1, "Invented.", "the board voted to sell the substation to a private buyer", "absent", "the span is not in the source", now, null);
  ins.run(document_id, 1, "Judged already.", address, "absent", "the span is not in the source", now, "right");
  rec.db.prepare("DELETE FROM meta WHERE key = 'refusals_rechecked'").run();
  rec.db.close();

  // Opening the record is what re-checks it, so every way in (the app, the development server, the
  // command line) reaches documents read before the fix.
  const again = openRecord(dir);
  const claim = again.db.prepare("SELECT page_no, quote FROM claims WHERE text = 'Meetings are archived online.'").get() as { page_no: number; quote: string } | undefined;
  assert.equal(claim?.quote, address, "the address is now a claim");
  const left = again.db.prepare("SELECT claim_text FROM ledger ORDER BY id").all().map((r: any) => r.claim_text);
  assert.deepEqual(left, ["Invented.", "Judged already."], "an absent quote and a person's judgment stay as they were");
  assert.deepEqual(recheckRefusals(again.db), { kept: 0 }, "and it runs once per locator revision");
  again.db.close();
  rmSync(dir, { recursive: true, force: true });
});
