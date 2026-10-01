/**
 * Leaving a document out removes what the record read from it, from the disk and not only from the
 * tables: every byte under the data directory is read afterwards, write-ahead log included, the way
 * invariant 6 is checked. A later document's change record that quoted it loses that quote too.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmLocation, openRecord } from "../src/record/db.js";
import { intake } from "../src/ingest/intake.js";
import { createIntakeQueue } from "../src/ingest/queue.js";
import { includeAgain, leaveOut } from "../src/record/remove.js";
import { dataDirFor, digestOf, listFolder, readFolder } from "../src/ui/folder.js";
import { findNonce, NONCE } from "./fixtures.js";

const idle = { reading: null, waiting: [], paths: [], failed: [] };

test("leaving a document out removes every byte of it, including quotes of it elsewhere", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-remove-"));
  const data = dataDirFor(dir);
  confirmLocation(data, "the test");
  const rec = openRecord(data);
  const a = join(dir, "a.txt");
  const b = join(dir, "b.txt");
  writeFileSync(a, `Contract PO-44821 in an amount not to exceed $1,200,000 for the ${NONCE} substation.\n`);
  writeFileSync(b, "Contract PO-44821 in an amount not to exceed $1,500,000 for the substation.\n");
  await intake(rec, a, { layer: "public" });
  await intake(rec, b, { layer: "public" });
  assert.ok(findNonce(data).length > 0, "the control: before leaving out, the nonce IS on disk, or this proves nothing");

  const out = leaveOut(rec, digestOf(a)!);
  assert.equal(out.removed, true);
  assert.deepEqual(findNonce(data), [], "nothing of the document remains under the data directory");
  assert.equal(listFolder(dir, rec, idle).files.find((f) => f.name === "a.txt")!.state, "left out");
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a left-out file is not read again until it is included again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-remove2-"));
  confirmLocation(dataDirFor(dir), "the test");
  const rec = openRecord(dataDirFor(dir));
  writeFileSync(join(dir, "a.txt"), "Agenda");
  leaveOut(rec, digestOf(join(dir, "a.txt"))!);
  const read: string[] = [];
  const q = createIntakeQueue({ model: "none", run: async (_r, file) => { read.push(file); return {} as never; } });
  readFolder(dir, rec, q);
  await q.settled();
  assert.equal(read.length, 0, "left out means not read");
  includeAgain(rec, digestOf(join(dir, "a.txt"))!);
  readFolder(dir, rec, q);
  await q.settled();
  assert.equal(read.length, 1, "included again means read again");
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});
