/**
 * Invariant 8, at the filesystem: the record lives only where the person put it on purpose.
 *
 * A location is refused unless it carries a marker written when the person confirmed it. A synced folder or
 * a git repository is the person's to choose, so each is told to them rather than refused: most people keep
 * their folders on a Desktop that iCloud mirrors. The verdict says what was checked AND what it
 * cannot see (proposal, invariant 8 and risk 3).
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export const MARKER = ".bearing-diligence-location";

/**
 * The path with every symlink resolved, as far as the filesystem actually exists.
 *
 * `resolve()` normalises a path lexically and follows NOTHING, so a directory that is a symlink into
 * Dropbox looked like an ordinary directory and passed every check. Proved end to end on
 * 2026-09-22: a record confirmed through such a link reported ok with zero refusals and wrote
 * record.sqlite and the whole raw store inside the synced folder. Relocating a large store off a
 * small boot disk is exactly how somebody makes that link.
 *
 * The directory may not exist yet, so this resolves the deepest ancestor that does and appends the
 * rest, which is enough: a symlink anywhere above the target is what has to be caught.
 */
export function trueLocation(dir: string): string {
  let head = resolve(dir);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail);
    } catch {
      const up = dirname(head);
      if (up === head) return resolve(dir);
      tail.unshift(head.slice(up.length + 1));
      head = up;
    }
  }
}

export type LocationVerdict = {
  ok: boolean;
  dir: string;
  refusals: string[];
  checked: string[];
  cannotSee: string[];
  observed: string[];
};

/** Folder names that mean a cloud service is mirroring. Never the whole answer, only the loud part. */
const SYNCED = [
  "Library/Mobile Documents",
  "Library/CloudStorage",
  "Dropbox",
  "Google Drive",
  "GoogleDrive",
  "OneDrive",
  "Box Sync",
  "pCloud",
  "MEGA",
  "Sync.com",
  "Creative Cloud Files",
  "iCloud Drive",
  "Desktop",
  "Documents",
];

function insideGitWorkTree(dir: string): string | null {
  let d = resolve(dir);
  for (;;) {
    if (existsSync(join(d, ".git"))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

function syncedSegment(dir: string): string | null {
  const home = homedir();
  const abs = resolve(dir);
  for (const s of SYNCED) {
    const asPath = join(home, s);
    if (abs === asPath || abs.startsWith(asPath + sep)) return s;
    // Also catch the folder name anywhere in the path, which is how a second account's Dropbox looks.
    if (s.indexOf("/") === -1 && abs.split(sep).includes(s)) return s;
  }
  return null;
}

/** Backup software that copies the whole disk. Reported, never refused: it is the person's to decide. */
function backupsSeen(): string[] {
  const seen: string[] = [];
  const probes: Array<[string, string]> = [
    ["/Library/Backblaze.bzpkg", "Backblaze"],
    [join(homedir(), "Library/Application Support/Arq"), "Arq"],
    [join(homedir(), "Library/Application Support/Arq Agent"), "Arq"],
    ["/Library/CrashPlan", "CrashPlan"],
    ["/Applications/Carbon Copy Cloner.app", "Carbon Copy Cloner"],
  ];
  for (const [p, name] of probes) if (existsSync(p) && !seen.includes(name)) seen.push(name);
  return seen;
}

export function checkLocation(dir: string): LocationVerdict {
  const given = resolve(dir);
  const abs = trueLocation(dir);
  const refusals: string[] = [];
  const checked: string[] = [];

  checked.push("every symlink in the path, resolved before anything else is asked");
  if (abs !== given) {
    checked.push(`the path given was ${given} and it really is ${abs}`);
  }

  checked.push("a confirmation marker written when the location was chosen");
  const marker = join(abs, MARKER);
  if (!existsSync(marker)) {
    refusals.push(
      `no ${MARKER} in ${abs}. A location is used only when it was chosen on purpose, so this refuses ` +
        `every directory it was not pointed at, including ones that look fine.`,
    );
  } else {
    try {
      const body = JSON.parse(readFileSync(marker, "utf8")) as { dir?: string };
      if (body.dir && trueLocation(body.dir) !== abs) {
        refusals.push(`${MARKER} was written for ${body.dir} and this is ${abs}, so the directory was moved or copied.`);
      }
    } catch {
      refusals.push(`${MARKER} is not readable as JSON, so it cannot say what it confirmed.`);
    }
  }

  const observed: string[] = [];

  checked.push("whether the path is inside a git working tree");
  const git = insideGitWorkTree(abs);
  if (git) {
    observed.push(
      `this folder is inside the git repository at ${git}; the record's own .gitignore keeps it out of commits`,
    );
  }

  checked.push("whether the path is inside a folder a cloud service is known to mirror");
  const synced = syncedSegment(abs);
  if (synced) {
    observed.push(`this folder is inside ${synced}, which a cloud service may copy to its servers along with the record`);
  }

  checked.push("whether the path exists and is a directory");
  if (existsSync(abs) && !statSync(abs).isDirectory()) refusals.push(`${abs} is not a directory.`);

  for (const b of backupsSeen()) observed.push(`${b} is installed on this machine and can copy the record off it`);

  return {
    ok: refusals.length === 0,
    dir: abs,
    refusals,
    checked,
    observed,
    cannotSee: [
      "whole disk backup, which copies the record off the machine without the directory ever sitting in a synced folder",
      "a filesystem snapshot, which keeps a deleted row outside the tool's own files",
      "a sync client that is not in the list above",
      "a network mount that is mirrored on the other end",
    ],
  };
}
