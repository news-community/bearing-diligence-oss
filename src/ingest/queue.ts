/**
 * Documents added in the shell are read one at a time, and adding one never waits for the reading.
 *
 * A 250-page packet took 56.8 and 102.6 minutes on two runs (docs/STATUS.md), and the shell's add
 * handler used to await the whole of it: the call did not return for that long, nothing stopped a
 * second model run starting on the same record beside the first, and one file's error was lost in
 * the promise shared by all of them.
 *
 * So adding queues and returns, and one intake runs at a time. Progress and outcome live where they
 * already did, in the runs table the Reading panel polls (src/record/runs.ts); an intake that throws
 * is recorded there as a failed run, so nothing new stores outcomes.
 *
 * Each job carries the record it was added to. Opening another record while one is being read must
 * not send the rest of the queue into the new one.
 */
import { basename } from "node:path";
import type { Record as OpenRecord } from "../record/db.js";
import { failIntake } from "../record/runs.js";
import { intake } from "./intake.js";

export type Job = { record: OpenRecord; file: string; layer: "public" | "private" };
/**
 * `paths` is every queued file in full, the one being read first. `failed` is every file whose
 * intake threw in this session, so a folder refresh does not queue it again every few seconds.
 */
export type QueueState = { reading: string | null; waiting: string[]; paths: string[]; failed: string[] };

export function createIntakeQueue(opts: { model: string; run?: typeof intake }) {
  const run = opts.run ?? intake;
  const waiting: Job[] = [];
  let current: Job | null = null;
  let idle: Array<() => void> = [];
  const failed = new Set<string>();

  async function drain(): Promise<void> {
    if (current) return;
    for (let job = waiting.shift(); job; job = waiting.shift()) {
      current = job;
      const since = new Date().toISOString();
      try {
        await run(job.record, job.file, { layer: job.layer, model: opts.model });
      } catch (e) {
        failed.add(job.file);
        failIntake(job.record.db, { filename: basename(job.file), model: opts.model, since }, (e as Error).message);
      }
    }
    current = null;
    const done = idle;
    idle = [];
    for (const resolve of done) resolve();
  }

  return {
    /** A file already reading or waiting is not queued twice. */
    add(jobs: Job[]): QueueState {
      const queued = new Set([current?.file, ...waiting.map((j) => j.file)]);
      waiting.push(...jobs.filter((j) => !queued.has(j.file)));
      void drain();
      return this.state();
    },
    /** Take a waiting file out of the queue. The one being read cannot be. */
    remove(file: string): void {
      const i = waiting.findIndex((j) => j.file === file);
      if (i !== -1) waiting.splice(i, 1);
    },
    state(): QueueState {
      return {
        reading: current ? basename(current.file) : null,
        waiting: waiting.map((j) => basename(j.file)),
        paths: [...(current ? [current.file] : []), ...waiting.map((j) => j.file)],
        failed: [...failed],
      };
    },
    busy(): boolean {
      return current !== null || waiting.length > 0;
    },
    /** Resolves when nothing is reading or waiting. For tests, and for closing a record safely. */
    settled(): Promise<void> {
      return this.busy() ? new Promise((resolve) => idle.push(resolve)) : Promise.resolve();
    },
  };
}

export type IntakeQueue = ReturnType<typeof createIntakeQueue>;
