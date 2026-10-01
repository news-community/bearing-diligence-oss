/**
 * Opening a folder, and remembering it.
 *
 * Confirming a folder is the deliberate act invariant 8 rests on (docs/design.md), so it happens in the main
 * process and the page supplies no path.
 *
 * The dialogs are passed in, so this runs, and is tested, without Electron. The shell passes its
 * native folder picker and a native confirmation dialog.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { confirmable, confirmLocation } from "../record/db.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { type LocationVerdict } from "../util/paths.js";
import { dataDirFor } from "./folder.js";

export type Dialogs = {
  /** A folder, or null when cancelled. */
  pickFolder(defaultPath: string): Promise<string | null>;
  /** Shown the verdict on the record's data folder inside it; true only when the person approves. */
  approve(folder: string, verdict: LocationVerdict): Promise<boolean>;
};

export type Chosen =
  | { ok: true; dir: string }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; verdict: LocationVerdict };

/**
 * A person opens a folder of documents. The record's data goes in a hidden folder inside it, and that is
 * the location confirmed, so moving the folder whole keeps the record with it.
 */
export async function chooseRecord(dialogs: Dialogs, confirmedBy: string): Promise<Chosen> {
  const folder = await dialogs.pickFolder(homedir());
  if (!folder) return { ok: false, cancelled: true };
  const data = dataDirFor(folder);

  // Refused before the person is asked: a folder that confirming would refuse is never offered for approval.
  const verdict = confirmable(data);
  if (!verdict.ok) return { ok: false, cancelled: false, verdict };

  if (!(await dialogs.approve(folder, verdict))) return { ok: false, cancelled: true };

  confirmLocation(data, confirmedBy);
  return { ok: true, dir: folder };
}

/**
 * The shell's memory of the folders it has opened, most recent first, each with when it was last
 * opened: one small file in the shell's own profile, holding paths and dates and nothing else. It is
 * a convenience and never a confirmation: the marker in each folder's data folder is what
 * checkLocation requires. The last-opened date is what "new since you last opened this folder" is
 * measured from; it says when, never what was asked.
 */
const REMEMBERED = "record.json";

export type RecentFolder = { dir: string; last_opened: string };

export function recentFolders(profileDir: string): RecentFolder[] {
  try {
    const body = JSON.parse(readFileSync(join(profileDir, REMEMBERED), "utf8")) as { recent?: unknown };
    return Array.isArray(body.recent)
      ? body.recent.filter((r): r is RecentFolder => typeof r?.dir === "string" && typeof r?.last_opened === "string")
      : [];
  } catch {
    return [];
  }
}

/** The folder the shell opens at launch: the most recent one. */
export function rememberedRecord(profileDir: string): string | null {
  return recentFolders(profileDir)[0]?.dir ?? null;
}

const writeRecent = (profileDir: string, recent: RecentFolder[]) =>
  writeFileSync(join(profileDir, REMEMBERED), JSON.stringify({ recent }, null, 1) + "\n");

/**
 * Open a folder: it moves to the front with today's date. Returns when it was opened BEFORE this,
 * which is what "since you last opened" compares against, or null the first time.
 */
export function rememberRecord(profileDir: string, dir: string): string | null {
  const recent = recentFolders(profileDir);
  const before = recent.find((r) => r.dir === dir)?.last_opened ?? null;
  writeRecent(profileDir, [{ dir, last_opened: new Date().toISOString() }, ...recent.filter((r) => r.dir !== dir)].slice(0, 12));
  return before;
}

/** Remove a folder from the list. Its files, and its record, are not touched. */
export function forgetFolder(profileDir: string, dir: string): void {
  writeRecent(profileDir, recentFolders(profileDir).filter((r) => r.dir !== dir));
}
