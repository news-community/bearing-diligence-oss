/**
 * Where reading stands in a folder: a file is read only when its reading FINISHED, one that stopped
 * partway is read again, and the time left is measured from this computer's finished readings.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmLocation, openRecord } from "../src/record/db.js";
import { addDocument } from "../src/record/store.js";
import { createIntakeQueue } from "../src/ingest/queue.js";
import { dataDirFor, listFolder, readFolder, span } from "../src/ui/folder.js";

const idle = { reading: null, waiting: [], paths: [], failed: [] };

function folderWith(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "pr-folder-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  confirmLocation(dataDirFor(dir), "the test");
  return { dir, rec: openRecord(dataDirFor(dir)) };
}

const run = (rec: ReturnType<typeof openRecord>, doc: number, r: { outcome: string | null; pid: number; seconds?: number; windows?: number }) =>
  rec.db
    .prepare(
      `INSERT INTO runs (document_id, filename, model, pid, started_at, heartbeat_at, finished_at, outcome, windows_total, windows_completed)
       VALUES (?, 'x', 'm', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(doc, r.pid, new Date(0).toISOString(), new Date(0).toISOString(),
         r.outcome ? new Date((r.seconds ?? 0) * 1000).toISOString() : null, r.outcome, r.windows ?? 0, r.outcome ? r.windows ?? 0 : 0);

test("durations read as a person would say them", () => {
  assert.equal(span(40), "40 seconds");
  assert.equal(span(600), "10 minutes");
  assert.equal(span(2 * 3600), "2.0 hours");
});

test("added is not read: only a FINISHED reading counts, and nothing measured says so", async () => {
  const { dir, rec } = folderWith({ "a.txt": "Agenda one", "b.txt": "Agenda two" });
  const a = await addDocument(rec, join(dir, "a.txt"), "public");
  const f = listFolder(dir, rec, idle);
  assert.deepEqual(f.files.map((x) => x.state), ["not read", "not read"], "a document with no finished run is not read");
  assert.match(f.summary, /0 of 2 ready, 2 still processing/);
  assert.match(f.summary, /no measured time/);
  run(rec, a.document_id, { outcome: "finished", pid: 1, seconds: 120, windows: 4 });
  assert.equal(listFolder(dir, rec, idle).files[0]!.state, "read");
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the time left is measured, with the sample size, and a stopped reading is read again", async () => {
  const { dir, rec } = folderWith({ "a.txt": "Agenda one", "b.txt": "Agenda two", "c.txt": "Agenda three" });
  const a = await addDocument(rec, join(dir, "a.txt"), "public");
  const b = await addDocument(rec, join(dir, "b.txt"), "public");
  run(rec, a.document_id, { outcome: "finished", pid: 1, seconds: 600, windows: 5 });
  run(rec, b.document_id, { outcome: null, pid: 999_999_999 }); // a process that is gone
  const f = listFolder(dir, rec, idle);
  assert.deepEqual(f.files.map((x) => x.state), ["read", "stopped partway", "not read"]);
  assert.match(f.summary, /Measured on this computer over 1 document: each took 10 minutes/);
  assert.match(f.summary, /About 20 minutes left/, f.summary);

  const read: string[] = [];
  const q = createIntakeQueue({ model: "none", run: async (_r, file) => { read.push(file); return {} as never; } });
  readFolder(dir, rec, q);
  await q.settled();
  assert.deepEqual(read.map((p) => p.slice(-5)), ["b.txt", "c.txt"], "the stopped one and the unread one, not the finished one");
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a file that could not be read is shown as such and not queued again on every refresh", async () => {
  const { dir, rec } = folderWith({ "a.txt": "Agenda" });
  let tries = 0;
  const q = createIntakeQueue({ model: "none", run: async () => { tries++; throw new Error("broken"); } });
  readFolder(dir, rec, q);
  await q.settled();
  const f = readFolder(dir, rec, q);
  await q.settled();
  assert.equal(tries, 1);
  assert.equal(f.files[0]!.state, "could not be read");
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});
