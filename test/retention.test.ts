/**
 * Invariant 6, checked the way the design says to check it: search the whole data directory for
 * the question text after asking one.
 *
 * This is the product's central claim. It held before this file existed, and it held by ACCIDENT:
 * the `questions` table is in the schema, nothing writes to it, and nothing else on the question
 * path persists anything either. An accident is not a property. A future commit adding a query
 * cache, a recent-questions list or an embedding cache for questions would break it silently, and
 * at least one comparable prototype stores the question inside its retrieval receipt by
 * design, so this is a live failure mode rather than a hypothetical one.
 *
 * The nonce is a word no board packet or fixture contains, so a hit is the question and nothing
 * else. The test reads every byte of every file under the data directory, which includes the
 * write-ahead log and the shared-memory file: the same sibling's own review found deletion markers
 * surviving in exactly those two.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmLocation, openRecord } from "../src/record/db.js";
import { intake } from "../src/ingest/intake.js";
import { retrieveHybrid } from "../src/answer/retrieve.js";
import { answer } from "../src/answer/answer.js";
import { indexDocument } from "../src/answer/embed.js";
import { isUp } from "../src/harness/runtime.js";
import { findNonce, NONCE } from "./fixtures.js";

const up = await isUp();

const PACKET =
  "Resolution 2026-07 authorises Contract PO-44821 in an amount not to exceed $1,200,000. " +
  "The work is scheduled to be complete by October 15, 2026. The motion carried on a vote of 5-2.";

test("the nonce search can FIND the nonce, or this test proves nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-ret0-"));
  writeFileSync(join(dir, "planted.txt"), `a question about ${NONCE} was asked`);
  assert.deepEqual(
    findNonce(dir).map((p) => p.split("/").pop()),
    ["planted.txt"],
    "the control must fire, because a search that cannot find anything proves nothing",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("invariant 6: asking a question writes NO part of it to the data directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-ret1-"));
  confirmLocation(dir, "the test");
  const rec = openRecord(dir);
  const f = join(dir, "packet.txt");
  writeFileSync(f, PACKET);
  await intake(rec, f, { layer: "public" });

  // The packet itself is in the record on purpose. The question is not.
  const q = `what did the board decide about ${NONCE} and the substation`;
  const found = await retrieveHybrid(rec.db, q, 8);
  assert.ok(Array.isArray(found), "retrieval ran");

  rec.db.close(); // flush the write-ahead log into the file, so this reads what is really on disk
  const hits = findNonce(dir).filter((p) => !p.endsWith("packet.txt"));
  assert.deepEqual(hits, [], `the question text reached disk at: ${hits.join(", ")}`);
  rmSync(dir, { recursive: true, force: true });
});

test("invariant 6 holds through the EMBEDDING path, which sends the question to a model",
  { skip: !up ? "runtime down" : false }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-ret2-"));
    confirmLocation(dir, "the test");
    const rec = openRecord(dir);
    const f = join(dir, "packet.txt");
    writeFileSync(f, PACKET);
    const added = await intake(rec, f, { layer: "public" });
    await indexDocument(rec.db, added.added.document_id);

    // With the index populated, retrieveHybrid takes the vector branch, which embeds the question.
    // An embedding of the question is a derivative of it and must not be cached to disk either.
    const before = rec.db.prepare("SELECT COUNT(*) AS n FROM embeddings").get() as { n: number };
    await retrieveHybrid(rec.db, `tell me about ${NONCE} please`, 8);
    const after = rec.db.prepare("SELECT COUNT(*) AS n FROM embeddings").get() as { n: number };
    assert.equal(after.n, before.n, "embedding the question stored nothing: only passages are indexed");

    rec.db.close();
    const hits = findNonce(dir).filter((p) => !p.endsWith("packet.txt"));
    assert.deepEqual(hits, [], `the question or its embedding reached disk at: ${hits.join(", ")}`);
    rmSync(dir, { recursive: true, force: true });
  });

test("invariant 6 holds through a WHOLE answer, receipts included",
  { skip: !up ? "runtime down" : false }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-ret3-"));
    confirmLocation(dir, "the test");
    const rec = openRecord(dir);
    const f = join(dir, "packet.txt");
    writeFileSync(f, PACKET);
    await intake(rec, f, { layer: "public" });

    const a = await answer(rec.db, `what was decided about ${NONCE}`, { model: "gemma3:4b" });
    assert.ok(a.question.includes(NONCE), "the answer carries the question in MEMORY, which is fine");

    rec.db.close();
    const hits = findNonce(dir).filter((p) => !p.endsWith("packet.txt"));
    assert.deepEqual(hits, [], `answering wrote the question to disk at: ${hits.join(", ")}`);
    rmSync(dir, { recursive: true, force: true });
  });

test("invariant 6 holds for a FOLLOW-UP: the earlier turns are used in memory and written nowhere",
  { skip: !up ? "runtime down" : false }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-ret4-"));
    confirmLocation(dir, "the test");
    const rec = openRecord(dir);
    const f = join(dir, "packet.txt");
    writeFileSync(f, PACKET);
    await intake(rec, f, { layer: "public" });

    // Without the earlier question, "was it approved?" shares no word with the packet worth
    // searching on; with it, the search finds the contract. That is the follow-up working.
    const alone = await answer(rec.db, "was it approved?", { model: "gemma3:4b" });
    const followed = await answer(rec.db, "was it approved?", {
      model: "gemma3:4b",
      earlier: [{ question: `tell me about contract PO-44821 and ${NONCE}`, answer: "It is a contract." }],
    });
    assert.equal(alone.passages.length, 0, "the control: alone, the follow-up finds nothing");
    assert.ok(followed.passages.length > 0, "with the earlier question, it finds the contract");

    rec.db.close();
    const hits = findNonce(dir).filter((p) => !p.endsWith("packet.txt"));
    assert.deepEqual(hits, [], `a follow-up wrote an earlier question to disk at: ${hits.join(", ")}`);
    rmSync(dir, { recursive: true, force: true });
  });
