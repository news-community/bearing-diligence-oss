import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { checkLocation, MARKER, trueLocation } from "../src/util/paths.js";
import { confirmLocation, openRecord, LocationRefused } from "../src/record/db.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "pr-test-"));
}

test("an unconfirmed directory is refused, however clean it looks", () => {
  const dir = tmp();
  const v = checkLocation(dir);
  assert.equal(v.ok, false);
  assert.ok(v.refusals.some((r) => r.includes(MARKER)));
  rmSync(dir, { recursive: true, force: true });
});

test("a confirmed directory is ACCEPTED, which is the case a refuse-everything check would fail", () => {
  const dir = tmp();
  confirmLocation(dir, "the test");
  const v = checkLocation(dir);
  assert.equal(v.ok, true, `a clean confirmed location must be accepted: ${v.refusals.join("; ")}`);
  rmSync(dir, { recursive: true, force: true });
});

test("a git working tree is told to the person, not refused, once confirmed", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".git"), { recursive: true });
  const inner = join(dir, "store");
  mkdirSync(inner);
  writeFileSync(join(inner, MARKER), JSON.stringify({ dir: inner }));
  const v = checkLocation(inner);
  assert.equal(v.ok, true, v.refusals.join("; "));
  assert.ok(v.observed.some((o) => o.includes("git repository")));
  rmSync(dir, { recursive: true, force: true });
});

test("this repository's own path is refused, because nobody confirmed it", () => {
  const v = checkLocation(process.cwd());
  assert.equal(v.ok, false);
  assert.ok(v.refusals.length >= 1);
});

test("a synced folder is told to the person, not refused, and Desktop counts on this machine", () => {
  const v = checkLocation(join(homedir(), "Desktop", "anything"));
  assert.deepEqual(v.refusals.map((r) => r.split(" ")[0]), ["no"], "the only refusal is the missing confirmation");
  assert.ok(v.observed.some((o) => o.includes("inside Desktop")), v.observed.join("; "));
});

test("the refusal says what it cannot see", () => {
  const v = checkLocation(tmp());
  assert.ok(v.cannotSee.some((c) => c.includes("whole disk backup")));
  assert.ok(v.cannotSee.some((c) => c.includes("snapshot")));
});

test("opening a record in a refused location throws rather than starting", () => {
  const dir = tmp();
  assert.throws(() => openRecord(dir), LocationRefused);
  rmSync(dir, { recursive: true, force: true });
});

test("opening a record in a confirmed location works", () => {
  const dir = tmp();
  confirmLocation(dir, "the test");
  const rec = openRecord(dir);
  assert.ok(rec.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get());
  rec.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a record written by an older version gains the columns a new one needs", () => {
  const dir = tmp();
  confirmLocation(dir, "the test");
  // A record as version 2 wrote it: a ledger with no review columns.
  const first = openRecord(dir);
  first.db.exec("DROP TABLE ledger");
  first.db.exec(
    `CREATE TABLE ledger (id INTEGER PRIMARY KEY, document_id INTEGER, window_no INTEGER,
       claim_text TEXT, quote TEXT, verdict TEXT, reason TEXT, created_at TEXT)`,
  );
  // Stamped with the NEWEST version while missing its columns, which is exactly what an earlier
  // build produced: the version said 3 and the table said 2, and every version check skipped it.
  first.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '99')").run();
  first.db.prepare("INSERT INTO ledger (document_id, window_no, claim_text, quote, verdict, reason, created_at) VALUES (1,1,'c','q','absent','r','now')").run();
  first.db.close();

  const again = openRecord(dir);
  const cols = (again.db.prepare("PRAGMA table_info(ledger)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols.includes("reviewed_verdict"), `migration did not run: ${cols.join(", ")}`);
  assert.equal(
    (again.db.prepare("SELECT COUNT(*) AS n FROM ledger").get() as { n: number }).n, 1,
    "and the rows that were already there survived it",
  );
  again.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a symlink into a synced folder is seen through, and the person is told where it really is", () => {
  // Proved as a live bypass on 2026-09-22: the record wrote record.sqlite and the whole raw store
  // inside Dropbox while reporting a clean location, because resolve() follows no links.
  const base = tmp();
  const real = join(base, "Dropbox", "board");
  mkdirSync(real, { recursive: true });
  const link = join(base, "store");
  symlinkSync(real, link);
  const v = checkLocation(link);
  assert.ok(v.observed.some((o) => o.includes("inside Dropbox")), "a link into Dropbox is a location in Dropbox");
  assert.ok(v.checked.some((c) => c.includes("really is")), "and it says what the path really was");
  rmSync(base, { recursive: true, force: true });
});

test("confirming through a symlink into a synced folder records the real folder and says it syncs", () => {
  const base = tmp();
  const real = join(base, "Dropbox", "board");
  mkdirSync(real, { recursive: true });
  const link = join(base, "store");
  symlinkSync(real, link);
  confirmLocation(link, "the test");
  const r = openRecord(link);
  assert.equal(r.verdict.dir, trueLocation(real));
  assert.ok(r.verdict.observed.some((o) => o.includes("inside Dropbox")));
  r.db.close();
  rmSync(base, { recursive: true, force: true });
});

test("an ordinary directory is still accepted when it is not a link to anywhere", () => {
  const dir = tmp();
  confirmLocation(dir, "the test");
  assert.equal(checkLocation(dir).ok, true, "resolving links must not refuse everything");
  rmSync(dir, { recursive: true, force: true });
});

test("confirming never replaces a .gitignore that is already there", () => {
  const dir = tmp();
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  confirmLocation(dir, "the test");
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "node_modules\n");
  rmSync(dir, { recursive: true, force: true });
});
