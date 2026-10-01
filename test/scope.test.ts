/**
 * Asking one document: a question limited to a document never returns a passage from another, and
 * the source pane's page handler returns the whole page a citation came from.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmLocation, openRecord } from "../src/record/db.js";
import { intake } from "../src/ingest/intake.js";
import { retrieve, retrieveHybridReporting } from "../src/answer/retrieve.js";
import { API, type Ctx } from "../src/ui/api.js";
import { createIntakeQueue } from "../src/ingest/queue.js";

async function twoDocuments() {
  const dir = mkdtempSync(join(tmpdir(), "pr-scope-"));
  confirmLocation(dir, "the test");
  const rec = openRecord(dir);
  writeFileSync(join(dir, "a.txt"), "The substation contract was awarded to the lowest bidder.");
  writeFileSync(join(dir, "b.txt"), "The substation budget moved to the next fiscal year.");
  const a = await intake(rec, join(dir, "a.txt"), { layer: "public" });
  const b = await intake(rec, join(dir, "b.txt"), { layer: "public" });
  return { dir, rec, a: a.added.document_id, b: b.added.document_id };
}

test("a question limited to one document returns passages from that document only", async () => {
  const { dir, rec, a, b } = await twoDocuments();
  assert.deepEqual(new Set(retrieve(rec.db, "substation", 10).map((p) => p.document_id)), new Set([a, b]),
    "the control: unlimited, the word is found in both, or the limit proves nothing");
  assert.deepEqual(retrieve(rec.db, "substation", 10, b).map((p) => p.document_id), [b]);
  const hybrid = await retrieveHybridReporting(rec.db, "substation", { limit: 10, documentId: a });
  assert.ok(hybrid.passages.length > 0 && hybrid.passages.every((p) => p.document_id === a));
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the page handler returns a citation's whole page, by its id or by document and page", async () => {
  const { dir, rec, a } = await twoDocuments();
  const ctx: Ctx = { dir, since: null, version: "0", record: () => rec, intake: createIntakeQueue({ model: "none" }) };
  const cited = retrieve(rec.db, "contract", 1)[0]!;
  const byId = API.page.run(ctx, cited.id);
  assert.equal(byId.document_id, a);
  assert.match(byId.text, /lowest bidder/);
  assert.equal(API.page.run(ctx, { document: a, page: 1 }).text, byId.text);
  assert.throws(() => API.page.run(ctx, "p999999"), /not in the record/);
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});
