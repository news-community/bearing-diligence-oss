#!/usr/bin/env node
/**
 * Does asking for a UNIQUE quote reduce refusals?
 *
 * Same windows, same model, two system prompts, and the gate's verdicts counted for each. It writes
 * to no record: a bench answers one question and leaves nothing behind.
 *
 * Reading the refusals from a 250-page run found 63 of 66 were eight boilerplate sentences refused
 * as ambiguous. The claims were true and the quotes pointed at no single place, so the plan's
 * section 11.14 says to try the prompt before touching the gate. This is that.
 */
import { readFileSync } from "node:fs";
import { ask, GENERAL_MODEL } from "../dist/src/harness/model.js";
import { planWindows, INGEST_SYSTEM } from "../dist/src/ingest/pipeline.js";
import { locate, controlsPass } from "../dist/src/quote/locator.js";

const file = process.argv[process.argv.indexOf("--file") + 1];
const n = Number(process.argv[process.argv.indexOf("--windows") + 1] || 10);
// Which windows. The first run of this bench took the first 8 and both prompts refused NOTHING,
// because the repeated boilerplate this is about lives at windows 29, 43, 57, 71, 86, 100 and 114.
// A bench on material where the phenomenon does not occur measures the instrument, not the change.
const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1].split(",").map(Number)
  : null;
const model = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : GENERAL_MODEL;
if (!file || file.startsWith("--")) {
  console.error("usage: node tools/bench-prompt.mjs --file <text file> [--windows 10 | --only 29,43,57] [--model <name>]");
  process.exit(2);
}

const BEFORE =
  "You read one part of a board packet and list what it states. Every claim must carry a quote " +
  "copied EXACTLY from the text, word for word, at least 24 characters long. Never write a quote " +
  "that is not in the text. Never join two separate sentences into one quote. If the part states " +
  "nothing, return an empty list.";

const SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: { type: "object", properties: { claim: { type: "string" }, quote: { type: "string" } }, required: ["claim", "quote"] },
    },
  },
  required: ["claims"],
};

const text = readFileSync(file, "utf8");
const pages = text.split("\f").map((t, i) => ({ page_no: i + 1, text: t, has_text_layer: t.trim().length > 0 }));
const all = planWindows(pages);
const windows = only ? all.filter((w) => only.includes(w.window_no)) : all.slice(0, n);
console.log(`${windows.length} windows, ${model}, two prompts\n`);

async function run(label, system) {
  const tally = { located: 0, absent: 0, ambiguous: 0, recombined: 0, too_short: 0, empty_windows: 0, failures: 0 };
  const started = Date.now();
  for (const w of windows) {
    const covered = controlsPass(w.text);
    const res = await ask({ model, system, prompt: `TEXT OF PAGES ${w.page_from} TO ${w.page_to}:\n\n${w.text}`, format: SCHEMA, timeoutMs: 300000 });
    if (!res.ok) { tally.failures++; continue; }
    const claims = Array.isArray(res.value?.claims) ? res.value.claims : [];
    if (claims.length === 0) tally.empty_windows++;
    for (const c of claims) {
      const v = locate(String(c.quote ?? ""), w.text).verdict;
      tally[v] = (tally[v] ?? 0) + 1;
      if (v === "located" && !covered.covered) tally.located--;
    }
  }
  const secs = (Date.now() - started) / 1000;
  const refused = tally.absent + tally.ambiguous + tally.recombined + tally.too_short;
  console.log(`${label}: kept ${tally.located}, refused ${refused} ` +
    `(absent ${tally.absent}, ambiguous ${tally.ambiguous}, recombined ${tally.recombined}, too_short ${tally.too_short}), ` +
    `empty windows ${tally.empty_windows}, failures ${tally.failures}, ${secs.toFixed(0)}s`);
  return { kept: tally.located, refused, ...tally };
}

const before = await run("before (no uniqueness rule)", BEFORE);
const after = await run("after  (quote must be unique)", INGEST_SYSTEM);
const dRef = after.refused - before.refused;
const dKept = after.kept - before.kept;
console.log(`\nrefusals ${dRef >= 0 ? "+" : ""}${dRef}, claims kept ${dKept >= 0 ? "+" : ""}${dKept}`);
console.log(dRef < 0
  ? "The prompt reduced refusals on these windows. One bench on synthetic material, not a gate result."
  : "The prompt did NOT reduce refusals here, which is the answer the plan's next step depends on.");
