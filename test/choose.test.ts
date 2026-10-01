/**
 * Opening a folder of documents. The dialogs are stand-ins, so what is tested is the sequence:
 * refused before the person is asked, nothing written unless they approve, the record's data kept in a
 * hidden folder inside theirs, and a remembered folder that is not confirmed refused.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseRecord, rememberedRecord, rememberRecord } from "../src/ui/choose.js";
import { dataDirFor, listFolder, readFolder } from "../src/ui/folder.js";
import { openRecord, LocationRefused } from "../src/record/db.js";
import { createIntakeQueue } from "../src/ingest/queue.js";
import { MARKER } from "../src/util/paths.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

test("declining the dialog confirms nothing", async () => {
  const dir = tmp("pr-choose1-");
  const out = await chooseRecord({ pickFolder: async () => dir, approve: async () => false }, "the test");
  assert.deepEqual(out, { ok: false, cancelled: true });
  assert.equal(existsSync(join(dataDirFor(dir), MARKER)), false, "no marker unless the person approves");
  rmSync(dir, { recursive: true, force: true });
});

test("approving opens the folder: the record's data goes in a hidden folder inside it", async () => {
  const dir = tmp("pr-choose2-");
  const out = await chooseRecord({ pickFolder: async () => dir, approve: async () => true }, "the test");
  assert.deepEqual(out, { ok: true, dir });
  assert.ok(existsSync(join(dir, ".bearing-diligence", MARKER)));
  assert.equal(readFileSync(join(dataDirFor(dir), ".gitignore"), "utf8"), "*\n");
  openRecord(dataDirFor(dir)).db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a copied folder is refused BEFORE the person is asked, because its record was confirmed elsewhere", async () => {
  const a = tmp("pr-choose-a-");
  await chooseRecord({ pickFolder: async () => a, approve: async () => true }, "the test");
  const b = join(tmp("pr-choose-b-"), "copy");
  cpSync(a, b, { recursive: true });
  let asked = false;
  const out = await chooseRecord({ pickFolder: async () => b, approve: async () => (asked = true) }, "the test");
  assert.equal(out.ok, false);
  assert.ok(!out.ok && !out.cancelled && out.verdict.refusals.some((r) => r.includes("moved or copied")));
  assert.equal(asked, false, "the person is never asked to approve a folder that would then be refused");
});

test("a synced folder is offered for approval with the sync named", async () => {
  const base = tmp("pr-choose-sync-");
  const dir = join(base, "Dropbox", "board");
  mkdirSync(dir, { recursive: true });
  let told: string[] = [];
  const out = await chooseRecord(
    { pickFolder: async () => dir, approve: async (_f, v) => ((told = v.observed), true) },
    "the test",
  );
  assert.equal(out.ok, true);
  assert.ok(told.some((o) => o.includes("inside Dropbox")), told.join("; "));
  rmSync(base, { recursive: true, force: true });
});

test("cancelling the picker asks nothing and confirms nothing", async () => {
  let asked = false;
  const out = await chooseRecord({ pickFolder: async () => null, approve: async () => (asked = true) }, "the test");
  assert.deepEqual(out, { ok: false, cancelled: true });
  assert.equal(asked, false);
});

test("the folder's documents are listed and every unread one is queued once, private by subfolder", async () => {
  const dir = tmp("pr-folder-");
  mkdirSync(join(dir, "2026", "private"), { recursive: true });
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "agenda.txt"), "Agenda");
  writeFileSync(join(dir, "2026", "packet.pdf"), "%PDF-1.4");
  writeFileSync(join(dir, "2026", "private", "notes.md"), "my notes");
  writeFileSync(join(dir, "minutes.docx"), "binary");
  writeFileSync(join(dir, "script.js"), "code");
  writeFileSync(join(dir, "node_modules", "readme.txt"), "not theirs");
  await chooseRecord({ pickFolder: async () => dir, approve: async () => true }, "the test");
  const rec = openRecord(dataDirFor(dir));
  const read: string[] = [];
  const queue = createIntakeQueue({ model: "none", run: async (_r, file) => { read.push(file); return {} as never; } });

  const first = readFolder(dir, rec, queue);
  assert.deepEqual(first.files.map((f) => f.name).sort(),
    ["2026/packet.pdf", "2026/private/notes.md", "agenda.txt", "minutes.docx"]);
  assert.equal(first.files.find((f) => f.name === "minutes.docx")!.state, "cannot read this type yet");
  assert.equal(first.files.find((f) => f.name.endsWith("notes.md"))!.layer, "private");
  assert.equal(first.files.find((f) => f.name === "agenda.txt")!.layer, "public");

  readFolder(dir, rec, queue); // asking again while they wait queues nothing twice
  await queue.settled();
  assert.equal(read.length, 3, read.join(", "));
  assert.equal(listFolder(dir, rec, queue.state()).files.filter((f) => f.state === "waiting").length, 0);
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a remembered folder is a pointer, never a confirmation", () => {
  const profile = tmp("pr-profile-");
  const dir = tmp("pr-unmarked-");
  rememberRecord(profile, dir);
  assert.equal(rememberedRecord(profile), dir);
  assert.throws(() => openRecord(dataDirFor(rememberedRecord(profile)!)), LocationRefused, "an unconfirmed folder is refused however it was found");
  rmSync(profile, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

test("a profile with nothing remembered has no record, rather than a default one", () => {
  const profile = tmp("pr-profile2-");
  assert.equal(rememberedRecord(profile), null);
  rmSync(profile, { recursive: true, force: true });
});
