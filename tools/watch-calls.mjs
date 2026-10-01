#!/usr/bin/env node
/**
 * Every network call the application actually makes, recorded while it works.
 *
 * The gates read imports and URL literals, which is reading the code. This watches the running
 * thing: fetch is wrapped before anything is loaded, and every call is recorded with its URL and
 * the stack that made it. It is not the egress test, which needs a packet filter and root and can
 * see what a dependency does below this layer. It is the half of the question that can be answered
 * from inside the process.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const where = new Error().stack.split("\n").slice(2, 4).map((l) => l.trim()).join(" <- ");
  calls.push({ phase: globalThis.__phase ?? "setup", url: String(url), where });
  return realFetch(url, init);
};

const { confirmLocation, openRecord } = await import("../dist/src/record/db.js");
const { intake } = await import("../dist/src/ingest/intake.js");
const { answer } = await import("../dist/src/answer/answer.js");
const { retrieve } = await import("../dist/src/answer/retrieve.js");
const { GENERAL_MODEL } = await import("../dist/src/harness/model.js");
const { PACKET_A } = await import("../dist/test/fixtures.js");

const dir = mkdtempSync(join(tmpdir(), "pr-watch-"));
confirmLocation(dir, "the watcher");
const rec = openRecord(dir);
const f = join(dir, "packet.txt");
writeFileSync(f, PACKET_A);

// The whole intake, the one sequence the application runs (src/ingest/intake.ts). This watched
// addDocument and ingestDocument called directly until 2026-09-28, which skipped OCR, votes,
// commitments and the screen: it measured the network calls of a sequence nothing ships.
globalThis.__phase = "intake: add, read by code, read by the model, change record";
await intake(rec, f, { layer: "public", model: GENERAL_MODEL });

globalThis.__phase = "search, no model";
retrieve(rec.db, "substation rebuild contract", 5);

globalThis.__phase = "question time";
await answer(rec.db, "what is the amount of the substation rebuild contract?", { model: GENERAL_MODEL });

rec.db.close();
rmSync(dir, { recursive: true, force: true });

const byPhase = {};
for (const c of calls) (byPhase[c.phase] ??= []).push(c);
console.log("every network call the application made, by phase:\n");
for (const [phase, list] of Object.entries(byPhase)) {
  const hosts = {};
  for (const c of list) {
    const h = new URL(c.url).host;
    hosts[h] = (hosts[h] ?? 0) + 1;
  }
  console.log(`  ${phase}: ${list.length} call(s) ${JSON.stringify(hosts)}`);
}
const offMachine = calls.filter((c) => !/^(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(new URL(c.url).host));
console.log(`\noff-machine calls: ${offMachine.length}`);
for (const c of offMachine.slice(0, 10)) console.log(`  ${c.phase}: ${c.url}\n    ${c.where}`);
console.log(
  offMachine.length === 0
    ? "\nEvery call went to loopback. This watches THIS layer: a dependency calling out below it, or the\nsidecar, or the runtime itself, is invisible here and is what the egress test is for."
    : "\nSOMETHING WENT OFF THIS MACHINE.",
);
