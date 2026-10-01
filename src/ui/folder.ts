/**
 * The folder the person opens is the folder that is read.
 *
 * The person chooses a folder of documents; the record keeps its own data in a hidden `.bearing-diligence`
 * folder inside it, with a .gitignore, so the record travels with the documents and is never
 * committed. Every PDF and text file in the folder and its subfolders is listed, and any not yet in
 * the record is queued to be read, one at a time. A file whose bytes changed is a new document, which
 * is what the change record compares against.
 *
 * A file under a folder named "private", at any depth, is added to the private layer; everything
 * else is public. Documents of a type the extractor cannot read are listed as such rather than read
 * as garbage, and every other file (code, images, media) is ignored.
 */
import { readdirSync, statSync } from "node:fs";
import { pidAlive } from "../record/runs.js";
import { documentLabel } from "./doc-label.js";
import { extname, join, relative, sep } from "node:path";
import type { Record as OpenRecord } from "../record/db.js";
import { digestFile } from "../util/digest.js";
import type { IntakeQueue, QueueState } from "../ingest/queue.js";

export const DATA = ".bearing-diligence";
export const dataDirFor = (folder: string) => join(folder, DATA);

const READABLE = new Set([".pdf", ".txt", ".md"]);
const NOT_YET = new Set([".doc", ".docx", ".rtf", ".pages", ".odt", ".ppt", ".pptx", ".key", ".xls", ".xlsx", ".numbers"]);
const SKIP = new Set(["node_modules"]);
/** Enough for any board's folder, and a bound on a folder that is really a whole disk. */
const LIMIT = 2000;

export type FolderFile = {
  path: string;
  name: string;
  layer: "public" | "private";
  /** The record's document for these exact bytes, once read. */
  document_id?: number;
  state: "read" | "reading" | "waiting" | "not read" | "stopped partway" | "could not be read" | "left out" | "cannot read this type yet";
  /** For the file being read: how far, in the windows the model reads it in. */
  detail?: string;
  /** The file's own modified time, in milliseconds, for sorting by date. */
  modified?: number;
  /** How a person reads the name: "March 19, 2026 · Agenda" (src/ui/doc-label.ts). */
  label: string;
};
/** A document in the record with no file of the same bytes in the folder: an earlier version, or a file since deleted or moved. */
export type Elsewhere = { document_id: number; filename: string; added_at: string };
/** `eta` is the measured time left, in short form for the header, when there is a measurement. */
export type FolderListing = { folder: string; files: FolderFile[]; elsewhere: Elsewhere[]; truncated: boolean; summary: string; eta?: string };

function walk(folder: string): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  const stack = [folder];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        const ext = extname(e.name).toLowerCase();
        if (READABLE.has(ext) || NOT_YET.has(ext)) files.push(p);
        if (files.length >= LIMIT) return { files: files.sort(), truncated: true };
      }
    }
  }
  return { files: files.sort(), truncated: false };
}

const layerOf = (folder: string, file: string): FolderFile["layer"] =>
  relative(folder, file).split(sep).slice(0, -1).some((d) => d.toLowerCase() === "private") ? "private" : "public";

/** Digests are cached by path, size and modified time, so a folder is not re-hashed on every poll. */
const seen = new Map<string, { size: number; mtime: number; digest: string }>();
const modifiedOf = (file: string): number | undefined => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
};
function digestOf(file: string): string | null {
  try {
    const s = statSync(file);
    const hit = seen.get(file);
    if (hit && hit.size === s.size && hit.mtime === s.mtimeMs) return hit.digest;
    const digest = digestFile(file);
    seen.set(file, { size: s.size, mtime: s.mtimeMs, digest });
    return digest;
  } catch {
    return null;
  }
}

type LastRun = { outcome: string | null; pid: number; started_at: string; windows_total: number; windows_completed: number; current_window: number };

/** A file is read only when its last reading FINISHED; being added is not being read. */
function stateOf(run: LastRun | undefined): FolderFile["state"] {
  if (!run) return "not read";
  if (run.outcome === "finished") return "read";
  if (run.outcome === "failed") return "could not be read";
  return pidAlive(run.pid) ? "reading" : "stopped partway";
}

export function listFolder(folder: string, rec: OpenRecord, q: QueueState, now = Date.now()): FolderListing {
  const { files, truncated } = walk(folder);
  const held = rec.db.prepare<[string], { id: number }>("SELECT id FROM documents WHERE digest = ?");
  const last = rec.db.prepare<[number], LastRun>(
    "SELECT outcome, pid, started_at, windows_total, windows_completed, current_window FROM runs WHERE document_id = ? ORDER BY id DESC LIMIT 1",
  );
  const leftOut = rec.db.prepare<[string], { digest: string }>("SELECT digest FROM left_out WHERE digest = ?");
  const firstPage = rec.db.prepare<[number], { text: string }>("SELECT text FROM pages WHERE document_id = ? AND page_no = 1");
  const present = new Set<string>();
  let current: LastRun | undefined;
  const listed = files.map((path): FolderFile => {
    const modified = seen.get(path)?.mtime ?? modifiedOf(path);
    const name = relative(folder, path);
    const base: Omit<FolderFile, "state"> = { path, name, layer: layerOf(folder, path), modified, label: documentLabel(name.split("/").pop()!, null, modified).label };
    if (!READABLE.has(extname(path).toLowerCase())) return { ...base, state: "cannot read this type yet" };
    const d = digestOf(path);
    if (d) present.add(d);
    if (d && leftOut.get(d)) return { ...base, state: "left out" };
    const doc = d ? held.get(d) : undefined;
    const withDoc = doc
      ? { ...base, document_id: doc.id, label: documentLabel(name.split("/").pop()!, firstPage.get(doc.id)?.text, modified).label }
      : base;
    const run = doc ? last.get(doc.id) : undefined;
    if (q.reading && q.paths[0] === path) {
      if (run && run.outcome === null && run.windows_total) {
        current = run;
        return { ...withDoc, state: "reading", detail: `window ${run.current_window} of ${run.windows_total}` };
      }
      return { ...withDoc, state: "reading", detail: "opening the file" };
    }
    if (q.paths.includes(path)) return { ...withDoc, state: "waiting" };
    if (q.failed.includes(path)) return { ...withDoc, state: "could not be read" };
    return { ...withDoc, state: stateOf(run) };
  });
  const elsewhere = rec.db
    .prepare<[], Elsewhere & { digest: string }>("SELECT id AS document_id, filename, added_at, digest FROM documents ORDER BY added_at DESC")
    .all()
    .filter((d) => !present.has(d.digest))
    .map(({ document_id, filename, added_at }) => ({ document_id, filename, added_at }));
  return { folder, truncated, files: listed, elsewhere, ...summarise(rec, listed, current, now) };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : 0;
};

/** A duration for a person: seconds, minutes or hours, never more precision than it has. */
export function span(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} seconds`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} minutes`;
  return `${(seconds / 3600).toFixed(1)} hours`;
}

/**
 * Where reading stands, and how long the rest will take, MEASURED on this computer from the
 * readings that finished here. Nothing is modelled: the time left is the measured time per window
 * for the document being read, and the measured typical time per document for the rest, with the
 * sample size and range stated so a reader knows how far to trust it. Documents differ in length, so
 * the estimate for the waiting ones is rough and says so.
 */
function summarise(rec: OpenRecord, files: FolderFile[], current: LastRun | undefined, now: number): { summary: string; eta?: string } {
  const readable = files.filter((f) => f.state !== "cannot read this type yet" && f.state !== "left out");
  const count = (st: FolderFile["state"]) => files.filter((f) => f.state === st).length;
  const cannot = count("cannot read this type yet");
  const failed = count("could not be read");
  const left = count("reading") + count("waiting") + count("not read") + count("stopped partway");
  if (!files.length) return { summary: "No PDFs or text files in this folder yet. Put documents in it and they will be read." };
  let eta: string | undefined;

  // "Ready", not "read": the documents are ready to ask about; the person has not read them.
  const parts = [`${count("read")} of ${readable.length} ready` + (left ? `, ${left} still processing` : "") + "."];
  if (failed) parts.push(`${failed} could not be read.`);
  if (cannot) parts.push(`${cannot} of a type this cannot read yet.`);
  const out = count("left out");
  if (out) parts.push(`${out} left out.`);

  if (left) {
    const done = rec.db
      .prepare<[], { started_at: string; finished_at: string; windows_total: number }>(
        "SELECT started_at, finished_at, windows_total FROM runs WHERE outcome = 'finished' AND windows_total > 0",
      )
      .all()
      .map((r) => ({ seconds: (Date.parse(r.finished_at) - Date.parse(r.started_at)) / 1000, windows: r.windows_total }));
    if (!done.length) {
      parts.push(
        "Nothing has finished reading on this computer yet, so there is no measured time to go on. " +
          "For scale, a 250-page packet took 57 to 103 minutes on the machine this was built on.",
      );
    } else {
      const perDoc = done.map((d) => d.seconds);
      const perWindow = median(done.map((d) => d.seconds / d.windows));
      let rest = 0;
      if (current) {
        const elapsed = (now - Date.parse(current.started_at)) / 1000;
        const rate = current.windows_completed ? elapsed / current.windows_completed : perWindow;
        rest += Math.max(0, current.windows_total - current.windows_completed) * rate;
      }
      const waiting = left - (current ? 1 : 0);
      rest += waiting * median(perDoc);
      eta = `about ${span(rest)}`;
      parts.push(
        `Measured on this computer over ${done.length} ${done.length === 1 ? "document" : "documents"}: each took ` +
          (done.length === 1 ? span(perDoc[0]!) : `${span(Math.min(...perDoc))} to ${span(Math.max(...perDoc))}, typically ${span(median(perDoc))}`) +
          `. About ${span(rest)} left` +
          (waiting ? `, rough because documents differ in length` : "") + ".",
      );
    }
    parts.push("You can ask about anything already read. Closing the app stops reading, and the document it was on starts again the next time this folder opens.");
  }
  return { summary: parts.join(" "), eta };
}

/** A file in the listing, by its name relative to the folder: the page names files, never paths. */
export function fileIn(listing: FolderListing, name: unknown): FolderFile {
  const f = listing.files.find((x) => x.name === name);
  if (!f) throw new Error(`not a file in this folder: ${String(name)}`);
  return f;
}

export { digestOf };

/**
 * Queue every readable file not yet read (never read, or stopped partway), and list the folder as
 * it now stands. Called when a folder opens and whenever the page asks, so a file dropped into the
 * folder is picked up without a button. A file that could not be read is not retried until it
 * changes or the app restarts.
 */
export function readFolder(folder: string, rec: OpenRecord, queue: IntakeQueue): FolderListing {
  const todo = listFolder(folder, rec, queue.state()).files.filter((f) => f.state === "not read" || f.state === "stopped partway");
  if (todo.length) queue.add(todo.map((f) => ({ record: rec, file: f.path, layer: f.layer })));
  return listFolder(folder, rec, queue.state());
}
