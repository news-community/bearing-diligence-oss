/**
 * What a run is doing, and what it did when it stopped.
 *
 * A job that reports nothing is indistinguishable from a job that hung, and the first thing anybody
 * does with a job that looks dead is start it again. Both of this project's own long runs were
 * started in exactly that shape, by the people building it, which is how this requirement reached
 * docs/design.md ("The change record").
 *
 * Three states, never one:
 *   running      the process is alive and wrote something recently
 *   not moving   the process is alive and has written nothing for longer than the stall window
 *   stopped      the process is gone and never recorded an outcome
 *
 * The third is the one that matters most on a machine that sleeps: a run killed by a closed lid
 * leaves a record that looks exactly like a run still going, unless somebody asks whether the
 * process is still there.
 */
import type Database from "better-sqlite3";

export type RunRow = {
  id: number;
  document_id: number | null;
  filename: string;
  model: string;
  pid: number;
  started_at: string;
  heartbeat_at: string;
  finished_at: string | null;
  outcome: "finished" | "failed" | null;
  windows_total: number;
  windows_completed: number;
  windows_failed: number;
  current_window: number;
  current_pages: string;
  claims_kept: number;
  claims_refused: number;
  failure_kinds: string;
  note: string;
};

export type RunState = RunRow & {
  state: "running" | "not_moving" | "stopped" | "finished" | "failed";
  seconds_since_heartbeat: number;
  seconds_running: number;
  percent: number;
  says: string;
};

/** CALIBRATE. A window took about 27 seconds on the reference machine, so silence past this is odd. */
export const STALL_SECONDS = 300;

export function startRun(
  db: Database.Database,
  args: { document_id: number; filename: string; model: string; windows_total: number },
): number {
  const now = new Date().toISOString();
  return Number(
    db
      .prepare(
        `INSERT INTO runs (document_id, filename, model, pid, started_at, heartbeat_at, windows_total)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(args.document_id, args.filename, args.model, process.pid, now, now, args.windows_total)
      .lastInsertRowid,
  );
}

export function beat(
  db: Database.Database,
  runId: number,
  p: {
    current_window: number;
    current_pages: string;
    windows_completed: number;
    windows_failed: number;
    claims_kept: number;
    claims_refused: number;
    failure_kinds: string;
  },
): void {
  db.prepare(
    `UPDATE runs SET heartbeat_at = ?, current_window = ?, current_pages = ?, windows_completed = ?,
       windows_failed = ?, claims_kept = ?, claims_refused = ?, failure_kinds = ? WHERE id = ?`,
  ).run(
    new Date().toISOString(),
    p.current_window,
    p.current_pages,
    p.windows_completed,
    p.windows_failed,
    p.claims_kept,
    p.claims_refused,
    p.failure_kinds,
    runId,
  );
}

export function endRun(db: Database.Database, runId: number, outcome: "finished" | "failed", note = ""): void {
  const now = new Date().toISOString();
  db.prepare("UPDATE runs SET finished_at = ?, heartbeat_at = ?, outcome = ?, note = ? WHERE id = ?").run(
    now,
    now,
    outcome,
    note,
    runId,
  );
}

/**
 * An intake that threw, recorded where every other outcome already is.
 *
 * Two shapes, and both end as ONE failed run. If the model's reading had started, its row is still
 * open, and in the shell it would read as running for as long as the window stayed open, because
 * the process that owns it is alive. If it failed earlier (the file could not be read, OCR threw)
 * there is no row at all, and a failure with no row is one the page cannot show. Nothing new stores
 * outcomes: the Reading panel already polls this table.
 *
 * `since` is when the intake began. The queue runs one intake at a time in this process, so an open
 * row from this pid started after it belongs to this intake and no other.
 */
export function failIntake(
  db: Database.Database,
  args: { filename: string; model: string; since: string },
  note: string,
): number {
  const open = db
    .prepare<[number, string], { id: number }>(
      "SELECT id FROM runs WHERE outcome IS NULL AND pid = ? AND started_at >= ? ORDER BY id DESC LIMIT 1",
    )
    .get(process.pid, args.since);
  if (open) {
    endRun(db, open.id, "failed", note);
    return open.id;
  }
  const now = new Date().toISOString();
  return Number(
    db
      .prepare(
        `INSERT INTO runs (document_id, filename, model, pid, started_at, heartbeat_at, finished_at, outcome, note)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, 'failed', ?)`,
      )
      .run(args.filename, args.model, process.pid, args.since, now, now, note).lastInsertRowid,
  );
}

/** Whether a process id is still there. The only way to tell a stopped run from a silent one. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function describeRuns(
  db: Database.Database,
  now = Date.now(),
  alive: (pid: number) => boolean = pidAlive,
): RunState[] {
  const rows = db.prepare<[], RunRow>("SELECT * FROM runs ORDER BY id DESC").all();
  return rows.map((r) => {
    const since = Math.max(0, Math.round((now - Date.parse(r.heartbeat_at)) / 1000));
    const running = Math.max(0, Math.round(((r.finished_at ? Date.parse(r.finished_at) : now) - Date.parse(r.started_at)) / 1000));
    const percent = r.windows_total ? Math.round((r.windows_completed / r.windows_total) * 100) : 0;

    let state: RunState["state"];
    let says: string;
    if (r.outcome === "finished" || r.outcome === "failed") {
      state = r.outcome;
      says =
        r.outcome === "finished"
          ? `Finished. ${r.windows_completed} of ${r.windows_total} windows read in ${minutes(running)}` +
            (r.windows_failed ? `, and ${r.windows_failed} failed (${r.failure_kinds}).` : ".")
          : `Stopped with an error after ${minutes(running)}. ${r.note}`;
    } else if (!alive(r.pid)) {
      state = "stopped";
      says =
        `STOPPED WITHOUT FINISHING. The process is gone and it never recorded an outcome, so this ` +
        `was interrupted rather than completed: at window ${r.current_window} of ${r.windows_total}, ` +
        `${minutes(running)} in. What it stored up to that point is in the record and the change ` +
        `record will say how much was read.`;
    } else if (since > STALL_SECONDS) {
      state = "not_moving";
      says =
        `NOT MOVING. The process is alive and has written nothing for ${minutes(since)}, at window ` +
        `${r.current_window} of ${r.windows_total}. That is longer than a window has ever taken here.`;
    } else {
      state = "running";
      says =
        `Running. Window ${r.current_window} of ${r.windows_total} (${percent}%), ${r.current_pages}, ` +
        `${r.claims_kept} claims kept and ${r.claims_refused} refused, last moved ${since}s ago.`;
    }
    return { ...r, state, seconds_since_heartbeat: since, seconds_running: running, percent, says };
  });
}

function minutes(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  return `${(seconds / 60).toFixed(1)} minutes`;
}
