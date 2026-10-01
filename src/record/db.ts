import Database from "better-sqlite3";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkLocation, LocationVerdict, MARKER, trueLocation } from "../util/paths.js";
import { recheckRefusals } from "../ingest/pipeline.js";
import { REQUIRED_COLUMNS, SCHEMA, SCHEMA_VERSION } from "./schema.js";

export class LocationRefused extends Error {
  constructor(public verdict: LocationVerdict) {
    super(
      `The record will not start here.\n` +
        verdict.refusals.map((r) => `  refused: ${r}`).join("\n") +
        `\n  checked: ${verdict.checked.join("; ")}` +
        `\n  cannot see: ${verdict.cannotSee.join("; ")}` +
        (verdict.observed.length ? `\n  also seen: ${verdict.observed.join("; ")}` : ""),
    );
    this.name = "LocationRefused";
  }
}

/**
 * What confirming this folder would refuse: every refusal but the missing marker, which is the one
 * confirming exists to write. Asked before the shell shows its dialog, so the person is never asked to
 * approve a folder that would then be refused, and asked again inside confirmLocation.
 */
export function confirmable(dir: string): LocationVerdict {
  const probe = checkLocation(dir);
  const refusals = probe.refusals.filter((r) => !r.startsWith(`no ${MARKER}`));
  return { ...probe, refusals, ok: refusals.length === 0 };
}

/** The deliberate act. Nothing else writes this marker, which is what makes the refusal deny by default. */
export function confirmLocation(dir: string, confirmedBy: string): void {
  mkdirSync(dir, { recursive: true });
  const probe = confirmable(dir);
  if (!probe.ok) throw new LocationRefused(probe);
  // The marker records where the directory REALLY is, so moving or re-linking it is visible.
  writeFileSync(
    join(dir, MARKER),
    JSON.stringify(
      { dir: trueLocation(dir), given_as: dir, confirmed_at: new Date().toISOString(), confirmed_by: confirmedBy },
      null,
      1,
    ),
  );
  // Keeps the record out of any repository the folder sits in, including one created around it later.
  // Never over an existing one: on 2026-09-29 this replaced a repository's own .gitignore.
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
}

export type Record = { db: Database.Database; dir: string; verdict: LocationVerdict };

export function openRecord(dir: string): Record {
  const verdict = checkLocation(dir);
  if (!verdict.ok) throw new LocationRefused(verdict);
  mkdirSync(join(dir, "raw"), { recursive: true });
  const db = new Database(join(dir, "record.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const stmt of SCHEMA) db.exec(stmt);

  // CREATE TABLE IF NOT EXISTS never adds a column to a table that is already there, so an existing
  // record needs its columns added by hand. This asks the TABLE what it has rather than asking the
  // version stamp, because a stamp written before its migration existed leaves a record that every
  // version check skips for ever (schema.ts).
  for (const need of REQUIRED_COLUMNS) {
    const have = (db.prepare(`PRAGMA table_info(${need.table})`).all() as Array<{ name: string }>).map((c) => c.name);
    if (have.length === 0 || have.includes(need.column)) continue;
    db.exec(`ALTER TABLE ${need.table} ADD COLUMN ${need.column} ${need.definition}`);
  }

  // A record written before the update trigger existed has a stale index for every page OCR
  // rewrote. Rebuilding is cheap and happens once, keyed on the record rather than on a version
  // number, because a version stamp has lied here before (schema.ts).
  const rebuilt = db.prepare<[], { value: string }>("SELECT value FROM meta WHERE key = 'fts_rebuilt_for_updates'").get();
  if (!rebuilt) {
    db.exec("INSERT INTO pages_fts(pages_fts) VALUES('rebuild')");
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('fts_rebuilt_for_updates', ?)").run(new Date().toISOString());
  }

  // Refusals stored before a locator fix are tried again once, so a fix reaches documents already
  // read and not only the next one (src/ingest/pipeline.ts, recheckRefusals).
  recheckRefusals(db);

  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  return { db, dir, verdict };
}
