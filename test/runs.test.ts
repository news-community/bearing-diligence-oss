import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmLocation, openRecord } from "../src/record/db.js";
import { addDocument } from "../src/record/store.js";
import { beat, describeRuns, endRun, startRun, STALL_SECONDS } from "../src/record/runs.js";
import { computeChangeRecord } from "../src/change/compare.js";
import { PACKET_A } from "./fixtures.js";

async function withRun() {
  const dir = mkdtempSync(join(tmpdir(), "pr-runs-"));
  confirmLocation(dir, "the test");
  const rec = openRecord(dir);
  const f = join(dir, "packet.txt");
  writeFileSync(f, PACKET_A);
  const added = await addDocument(rec, f, "public");
  const runId = startRun(rec.db, {
    document_id: added.document_id,
    filename: "packet.txt",
    model: "gemma3:4b",
    windows_total: 10,
  });
  beat(rec.db, runId, {
    current_window: 3, current_pages: "pages 5 to 7", windows_completed: 3,
    windows_failed: 0, claims_kept: 12, claims_refused: 1, failure_kinds: "",
  });
  return { dir, rec, runId, documentId: added.document_id };
}

const cleanup = (dir: string, rec: { db: { close(): void } }) => {
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
};

test("a live run that moved recently says it is running, and how far", async () => {
  const { dir, rec } = await withRun();
  const [r] = describeRuns(rec.db, Date.now(), () => true);
  assert.equal(r!.state, "running");
  assert.match(r!.says, /Window 3 of 10 \(30%\), pages 5 to 7/);
  assert.match(r!.says, /12 claims kept and 1 refused/);
  cleanup(dir, rec);
});

test("a live run that has written nothing for too long says NOT MOVING, not running", async () => {
  const { dir, rec } = await withRun();
  const later = Date.now() + (STALL_SECONDS + 60) * 1000;
  const [r] = describeRuns(rec.db, later, () => true);
  assert.equal(r!.state, "not_moving");
  assert.match(r!.says, /NOT MOVING/);
  assert.match(r!.says, /longer than a window has ever taken/);
  cleanup(dir, rec);
});

test("a run whose process is GONE says it was interrupted, not that it is running", async () => {
  const { dir, rec } = await withRun();
  const [r] = describeRuns(rec.db, Date.now(), () => false);
  assert.equal(r!.state, "stopped");
  assert.match(r!.says, /STOPPED WITHOUT FINISHING/);
  assert.match(r!.says, /window 3 of 10/);
  cleanup(dir, rec);
});

test("a finished run reports what it read rather than only that it ended", async () => {
  const { dir, rec, runId } = await withRun();
  endRun(rec.db, runId, "finished");
  const [r] = describeRuns(rec.db, Date.now(), () => false);
  assert.equal(r!.state, "finished");
  assert.match(r!.says, /Finished\. 3 of 10 windows read/);
  cleanup(dir, rec);
});

test("the three states are three states, and none of them is silence", async () => {
  const { dir, rec } = await withRun();
  const running = describeRuns(rec.db, Date.now(), () => true)[0]!.state;
  const stalled = describeRuns(rec.db, Date.now() + (STALL_SECONDS + 60) * 1000, () => true)[0]!.state;
  const gone = describeRuns(rec.db, Date.now(), () => false)[0]!.state;
  assert.equal(new Set([running, stalled, gone]).size, 3);
  cleanup(dir, rec);
});

test("a packet whose run never finished is NOT reported as complete coverage", async () => {
  const { dir, rec, documentId } = await withRun();
  rec.db
    .prepare("UPDATE coverage SET windows_total = 10, windows_completed = 3, windows_failed = 0, pages_read = 7 WHERE document_id = ?")
    .run(documentId);
  const cr = computeChangeRecord(rec.db, documentId);
  assert.equal(cr.coverage.complete, false);
  assert.match(cr.coverage.note, /7 of 10 windows were never reached/);
  assert.match(cr.coverage.note, /stopped early and a run that found nothing look the same/);
  cleanup(dir, rec);
});
