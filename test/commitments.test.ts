import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectCommitments, proposePairings } from "../src/commitments/detect.js";
import { buildBrief, renderBrief } from "../src/brief/brief.js";
import { confirmLocation, openRecord } from "../src/record/db.js";
import { addDocument } from "../src/record/store.js";
import { PACKET_A, PACKET_B } from "./fixtures.js";

const SAID =
  "Staff will report monthly on the substation rebuild and management will deliver a revised " +
  "schedule by October 15, 2026. The board discussed the matter at length.";

test("an undertaking is a commitment and a discussion is not", () => {
  const found = detectCommitments(SAID, 3);
  assert.equal(found.length, 2, JSON.stringify(found.map((f) => f.text)));
  assert.ok(found.every((f) => /will/.test(f.text)));
  assert.ok(!found.some((f) => /discussed/.test(f.text)));
});

test("a due date is read from the passage, not from a model", () => {
  const found = detectCommitments(SAID, 3);
  const dated = found.find((f) => f.due);
  assert.ok(dated);
  assert.equal(dated.due, "2026-10-15");
});

test("a pairing is a draft and says on what basis it was proposed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-commit-"));
  confirmLocation(dir, "the test");
  const rec = openRecord(dir);
  const a = join(dir, "a.txt");
  const b = join(dir, "b.txt");
  writeFileSync(a, PACKET_A + "\n\nStaff will report monthly on the substation rebuild schedule.");
  writeFileSync(b, PACKET_B);
  const docA = await addDocument(rec, a, "public");
  await addDocument(rec, b, "public");

  const page = rec.db.prepare<[number], { text: string }>("SELECT text FROM pages WHERE document_id = ?").get(docA.document_id)!;
  for (const c of detectCommitments(page.text, 1)) {
    rec.db
      .prepare("INSERT INTO commitments (document_id, page_no, text, passage, due) VALUES (?, ?, ?, ?, ?)")
      .run(docA.document_id, c.page_no, c.text, c.passage, c.due);
  }
  const pairs = proposePairings(rec.db, 2);
  assert.ok(pairs.length >= 1, "a later packet mentioning the substation rebuild is a candidate");
  assert.ok(pairs[0]!.shared.length >= 2, "the words the two passages share are named");
  const state = rec.db.prepare<[], { pairing_state: string }>("SELECT pairing_state FROM commitments").get()!;
  assert.equal(state.pairing_state, "draft", "nothing is accepted by the machine");
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the brief puts coverage first and carries both passages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-brief-"));
  confirmLocation(dir, "the test");
  const rec = openRecord(dir);
  const a = join(dir, "a.txt");
  const b = join(dir, "b.txt");
  writeFileSync(a, PACKET_A);
  writeFileSync(b, PACKET_B);
  await addDocument(rec, a, "public");
  const docB = await addDocument(rec, b, "public");

  const brief = buildBrief(rec.db, docB.document_id);
  const text = renderBrief(brief);
  assert.match(text, /^COVERAGE FIRST/);
  assert.match(text, /then: /);
  assert.match(text, /now:  /);
  assert.match(text, /Nothing here is a model's reading/);
  const res = brief.items.find((i) => i.subject === "resolution:2026-11");
  assert.ok(res?.is_new, "resolution 2026-11 is new to the record");
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});
