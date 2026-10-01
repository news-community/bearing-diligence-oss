/**
 * Documents added in the shell are read one at a time, and every outcome, failures included, lands
 * in the runs table the Reading panel already polls.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmLocation, openRecord } from "../src/record/db.js";
import { createIntakeQueue } from "../src/ingest/queue.js";
import { describeRuns, startRun } from "../src/record/runs.js";
import { intake } from "../src/ingest/intake.js";

function fresh(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  confirmLocation(dir, "the test");
  return { dir, rec: openRecord(dir) };
}

test("two documents added together are read one at a time, and both are read", async () => {
  const { dir, rec } = fresh("pr-queue1-");
  let reading = 0;
  let most = 0;
  const read: string[] = [];
  const q = createIntakeQueue({
    model: "unused",
    run: (async (_r: unknown, file: string) => {
      reading++;
      most = Math.max(most, reading);
      await new Promise((r) => setTimeout(r, 20));
      read.push(file);
      reading--;
    }) as unknown as typeof intake,
  });
  const state = q.add([
    { record: rec, file: "/a.pdf", layer: "public" },
    { record: rec, file: "/b.pdf", layer: "private" },
  ]);
  assert.deepEqual(state, { reading: "a.pdf", waiting: ["b.pdf"], paths: ["/a.pdf", "/b.pdf"], failed: [] }, "adding returns at once, with what is queued");
  // A second Add WHILE a document is being read, which is how two readings would start in the
  // shell. The first version of this test added both files in one call, one drain read them in
  // order either way, and the deletion pass removed the one-at-a-time guard with every test green.
  await new Promise((r) => setTimeout(r, 5));
  q.add([{ record: rec, file: "/c.pdf", layer: "public" }]);
  await q.settled();
  assert.equal(most, 1, "never two readings at once");
  assert.deepEqual(read, ["/a.pdf", "/b.pdf", "/c.pdf"]);
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("an intake that fails before any reading starts is recorded as a failed run, with its reason", async () => {
  const { dir, rec } = fresh("pr-queue2-");
  const q = createIntakeQueue({ model: "gemma3:4b" });
  q.add([{ record: rec, file: join(dir, "not-there.pdf"), layer: "public" }]);
  await q.settled();
  const runs = describeRuns(rec.db);
  assert.equal(runs.length, 1, "the failure is in the one place the page already reads");
  assert.equal(runs[0]!.state, "failed");
  assert.equal(runs[0]!.filename, "not-there.pdf");
  assert.match(runs[0]!.says, /ENOENT|no such file/);
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("an intake that fails mid-reading closes ITS run, rather than leaving it looking alive", async () => {
  const { dir, rec } = fresh("pr-queue3-");
  const f = join(dir, "p.txt");
  writeFileSync(f, "text");
  const q = createIntakeQueue({
    model: "gemma3:4b",
    // A real intake with no model, then a run started the way the pipeline starts one, then the
    // failure: the shape of the runtime dying partway through a reading.
    run: (async (r: typeof rec, file: string) => {
      const out = await intake(r, file, { layer: "public" });
      startRun(r.db, { document_id: out.added.document_id, filename: "p.txt", model: "gemma3:4b", windows_total: 4 });
      throw new Error("the runtime went away");
    }) as unknown as typeof intake,
  });
  q.add([{ record: rec, file: f, layer: "public" }]);
  await q.settled();
  const runs = describeRuns(rec.db);
  assert.equal(runs.length, 1, "one run, closed, and not a second row beside an open one");
  assert.equal(runs[0]!.state, "failed", "this process is alive, so an open row would read as running for ever");
  assert.match(runs[0]!.says, /the runtime went away/);
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});
