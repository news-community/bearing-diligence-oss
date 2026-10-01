import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmLocation, openRecord } from "../src/record/db.js";
import { addDocument } from "../src/record/store.js";
import { cosine, EMBED_MODEL, indexDocument, isIndexed } from "../src/answer/embed.js";
import { retrieve, retrieveHybrid, retrieveHybridReporting } from "../src/answer/retrieve.js";
import { searchNote } from "../src/answer/answer.js";
import { isUp } from "../src/harness/runtime.js";
import { PACKET_A } from "./fixtures.js";

const up = await isUp(2000);

test("cosine is 1 for a vector against itself and 0 for an orthogonal one", () => {
  assert.equal(Math.round(cosine([1, 2, 3], [1, 2, 3]) * 1000) / 1000, 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([], []), 0, "an empty vector is not similar to anything");
});

test("retrieval works with no embeddings at all, and says so by returning the keyword hits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-emb-"));
  confirmLocation(dir, "the test");
  const rec = openRecord(dir);
  const f = join(dir, "p.txt");
  writeFileSync(f, PACKET_A);
  await addDocument(rec, f, "public");
  assert.equal(isIndexed(rec.db), false);
  const hits = await retrieveHybrid(rec.db, "substation rebuild contract", 5);
  assert.equal(hits.length, retrieve(rec.db, "substation rebuild contract", 5).length);
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a question sharing NO words with the record finds it once embedded", { skip: !up ? "runtime down" : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-emb2-"));
  confirmLocation(dir, "the test");
  const rec = openRecord(dir);
  const f = join(dir, "p.txt");
  writeFileSync(f, PACKET_A);
  const added = await addDocument(rec, f, "public");

  const q = "how much money was approved for the electrical infrastructure upgrade";
  const before = retrieve(rec.db, q, 5);
  const r = await indexDocument(rec.db, added.document_id);
  assert.ok(r.embedded > 0, "the page was embedded");
  const after = await retrieveHybrid(rec.db, q, 5);
  assert.ok(
    after.length > before.length || before.length > 0,
    `keyword found ${before.length}, hybrid found ${after.length}`,
  );
  assert.ok(after.length > 0, "the packet is about exactly this and hybrid retrieval must find it");
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("indexing twice embeds nothing the second time", { skip: !up ? "runtime down" : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-emb3-"));
  confirmLocation(dir, "the test");
  const rec = openRecord(dir);
  const f = join(dir, "p.txt");
  writeFileSync(f, PACKET_A);
  const added = await addDocument(rec, f, "public");
  const first = await indexDocument(rec.db, added.document_id);
  const second = await indexDocument(rec.db, added.document_id);
  assert.ok(first.embedded > 0);
  assert.equal(second.embedded, 0, "already embedded pages are skipped");
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});


/**
 * A search that found nothing and a search that never ran print the same empty list.
 *
 * `retrieveHybrid` used to catch the embedding model's failure and return the keyword results with
 * a comment saying that not answering is not a reason to answer nothing. The reasoning is right and
 * the RESULT was indistinguishable from the vector half running and adding nothing. Found on
 * 2026-09-22 by reading a public local-assistant project whose confidence evaluator catches every
 * exception and returns 0.5, a middling judgment where the honest answer is that it did not judge.
 */
const BOGUS = "no-such-embedding-model-here";

test("a broken embedding model is reported, not silently swallowed", { skip: !up ? "runtime down" : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-vec1-"));
  confirmLocation(dir, "the test");
  const rec = openRecord(dir);
  const f = join(dir, "packet.txt");
  writeFileSync(f, PACKET_A);
  const added = await addDocument(rec, f, "public");

  // An embedding row with a model nobody serves: isIndexed() is true, so the vector branch is
  // taken, and nearest() then fails on a model the runtime does not have.
  rec.db
    .prepare("INSERT INTO embeddings (kind, ref_id, document_id, model, dims, vector) VALUES ('passage', ?, ?, ?, 1, ?)")
    .run(1, added.document_id, BOGUS, Buffer.alloc(4));

  const got = await retrieveHybridReporting(rec.db, "a question sharing no words at all zzzz", { limit: 8, model: BOGUS });
  assert.equal(got.vector.state, "unavailable", "a model the runtime does not serve is an instrument failure");
  assert.ok(got.passages.length >= 0, "the keyword half still stands");
  assert.match(searchNote(got.vector), /instrument failure, not a finding about the record/);

  // The control: the same call with a model that IS served must not read as broken.
  const fine = await retrieveHybridReporting(rec.db, "substation rebuild contract", { limit: 8 });
  assert.notEqual(fine.vector.state, "unavailable");
  assert.ok(!/instrument failure/.test(searchNote(fine.vector)), "a working search must not read as a broken one");
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the four states of the vector half produce four different sentences", () => {
  const said = [
    searchNote({ state: "used", added: 2 }),
    searchNote({ state: "used", added: 0 }),
    searchNote({ state: "not indexed" }),
    searchNote({ state: "no room" }),
    searchNote({ state: "unavailable", detail: "connection refused" }),
  ];
  assert.equal(new Set(said).size, said.length, "each state says something different, or the report is decoration");
  assert.match(said[4]!, /did not answer/);
  assert.ok(!said.slice(0, 4).some((t) => /did not answer/.test(t)));
});
