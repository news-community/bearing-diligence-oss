#!/usr/bin/env node
/**
 * The same questions, asked of one folder's record by each model named, scored the way the page
 * shows an answer: sentences kept, sentences left out, seconds, and whether the answer failed.
 *
 * It exists so that "the best model" is a measurement on this project's own material rather than a
 * reputation, and it measures only what code can count. Whether a kept sentence is supported is
 * still the reader's to judge (invariant 3), so every kept sentence is printed for reading.
 *
 *   npm run build && ELECTRON_RUN_AS_NODE=1 electron tools/compare-models.mjs \
 *     --dir "<folder>" --models local:gemma3:4b,local:gemma3:27b [--runs 2] [--reasoning off] [--out <file.json>]
 *
 * Recall is the share of the answer keys' facts found in KEPT sentences (see QUESTIONS); precision is
 * the kept share. Read the summary the way a small benchmark has to be read (after another project's published
 * method): a model that finished fewer than five of six questions in a run is listed as NOT RANKED
 * rather than scored on the few it managed; `--runs` repeats every question so the spread between
 * runs is visible, and a difference inside that spread is not a ranking; and the kept count rewards
 * a model that writes more, so the kept SHARE sits beside it and the kept sentences are for reading.
 *
 * A `cloud:<model id>` entry asks OpenRouter, which sends each question and its passages off this
 * computer. It needs the key in OPENROUTER_API_KEY for this one run, and it refuses to start without
 * --i-understand-this-sends-passages-to-openrouter. Public agendas only.
 */
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const val = (n, d) => (args.indexOf(`--${n}`) === -1 ? d : args[args.indexOf(`--${n}`) + 1]);
const dir = val("dir");
const models = (val("models", "local:gemma3:4b") ?? "").split(",").filter(Boolean);
const runs = Math.max(1, Number(val("runs", "1")) || 1);
if (!dir) {
  console.error("usage: --dir <folder> --models local:gemma3:4b,cloud:<id> [--out file.json]");
  process.exit(2);
}
if (models.some((m) => m.startsWith("cloud:")) && !args.includes("--i-understand-this-sends-passages-to-openrouter")) {
  console.error("Refusing: a cloud model sends each question and its passages to OpenRouter.\n" +
    "Public agendas only. Pass --i-understand-this-sends-passages-to-openrouter to go ahead.");
  process.exit(2);
}

const { openRecord } = await import("../dist/src/record/db.js");
const { dataDirFor } = await import("../dist/src/ui/folder.js");
const { answer } = await import("../dist/src/answer/answer.js");
const { askerFor } = await import("../dist/src/harness/choose.js");

/**
 * Research questions, fixed so every model answers the same thing, written from reading six public
 * utility-board agendas (2026-09-30). Each needs more than one passage or more than one meeting, the
 * kind of thing a person asks because they do not understand it yet; a lookup scores search, not
 * research. Each key is a fact a good answer contains, as patterns any one of which counts. Recall
 * counts only facts found in sentences the answer checks KEPT, so a fact stated without support
 * earns nothing. The keys are one reader's reading, a floor on a good answer rather than a gold one.
 */
const QUESTIONS = [
  { q: "Across these meetings, how much new contract spending was the board asked to approve, and which contracts make up that total?",
    keys: [["residential assistance", "Synergy"], ["TRC", "\\$8 million"], ["Itron", "smart meters"], ["\\$12 million", "CEQA"], ["NV5", "LiDAR"], ["\\$35 million", "remediation"]] },
  { q: "What was going on with the Wells Fargo and PNC lines of credit, and why might that item have drawn attention?",
    keys: [["\\$50 million"], ["\\$100 million"], ["PNC"], ["Discussion Calendar", "moved from (the )?Consent"]] },
  { q: "Which labor agreements came before the board, with which unions, and how do their terms compare?",
    keys: [["OSE", "Organization of SMUD Employees"], ["2029"], ["IBEW", "Electrical Workers"], ["2028"]] },
  { q: "Board member compensation comes up at every meeting. How do the periods line up, and was anything revised or reconsidered?",
    keys: [["revised"], ["November 16, 2025"], ["25-04-02"], ["GP-12", "Compensation and Benefits"], ["June 15, 2026"]] },
  { q: "What do these agendas tell me about the CEO and General Manager position?",
    keys: [["closed session"], ["54957"], ["January 15, 2026"], ["June 18, 2026"]] },
  { q: "Which Strategic Directions came up, and what did the board do with each one?",
    keys: [["SD-2", "Competitive Rates"], ["SD-3", "Access to Credit"], ["SD-6", "Safety Leadership"], ["SD-8", "Employee Relations"], ["SD-12", "Ethics"], ["SD-4", "Reliability"]] },
  { q: "Which items could affect what customers pay or how they are billed?",
    keys: [["Solar and Storage"], ["June 1, 2026"], ["smart meter", "Itron"], ["Competitive Rates", "SD-2"], ["bond", "Series P"]] },
  { q: "Which contracts were sole source or carry optional extensions, and how long could each run?",
    keys: [["sole source"], ["Itron"], ["two-year extension", "optional two-year"], ["three-year extension", "optional three-year"], ["April 30, 2031", "five years"]] },
  { q: "What land was the board asked to declare surplus, and what were those sites?",
    keys: [["Alamos"], ["substation"], ["Amador"], ["Ice House"], ["Surplus Land Act"]] },
  { q: "What election and governance changes came before the board, and when is the election?",
    keys: [["Wards 3"], ["November 3, 2026"], ["Meeting Procedures"], ["GP-12", "Governance Process"]] },
  { q: "What bonds is SMUD planning to issue, and what else would the board be authorizing along with them?",
    keys: [["Series P"], ["Series G"], ["Preliminary Official Statement"], ["Bond Purchase Agreement"]] },
  // The honest answer is that agendas do not record votes; a model that says so has found the key.
  { q: "How did the board vote on the IBEW agreement?",
    keys: [["(do|does|did) not (say|show|record|include|indicate|state)", "no (vote|record)", "not (recorded|shown|stated)", "agenda.{0,40}(only|lists)"]] },
];
const recallOf = (keys, kept) => {
  const text = kept.join(" ").replace(/\s+/g, " ");
  return keys.filter((alts) => alts.some((a) => new RegExp(a, "i").test(text))).length;
};

const rec = openRecord(dataDirFor(dir));
const rows = [];
for (const m of models) {
  const [where, ...rest] = m.split(":");
  // --reasoning off runs hosted models without reasoning, as the local harness runs thinking models,
  // so a hosted copy of a local model is compared on equal terms (2026-09-30: qwen3.5-9b reasoned to
  // its length limit on OpenRouter and never did locally).
  const choice = { where, model: rest.join(":"), ...(val("reasoning") === "off" ? { reasoning: "off" } : {}) };
  const asker = askerFor(choice, { cloudKey: process.env.OPENROUTER_API_KEY ?? "" });
  for (let run = 1; run <= runs; run++) for (const { q, keys } of QUESTIONS) {
    const t0 = Date.now();
    const a = await answer(rec.db, q, { model: choice.model, asker, via: choice.where });
    const seconds = (Date.now() - t0) / 1000;
    // The memory a local model actually took, read from the runtime while it is loaded, rather than
    // estimated from its file size (after another project's published "memory used" column).
    let memory_gb = null;
    if (where === "local") {
      try {
        const ps = await (await fetch("http://127.0.0.1:1948/api/ps")).json();
        const loaded = (ps.models ?? []).find((x) => x.name === choice.model || x.model === choice.model);
        if (loaded) memory_gb = Math.round((loaded.size / 1e9) * 10) / 10;
      } catch { /* the runtime did not say; recorded as unknown */ }
    }
    const kept = a.sentences.filter((s) => s.kept), dropped = a.sentences.filter((s) => !s.kept);
    rows.push({ model: m, run, question: q, seconds, memory_gb, keys: keys.length, found: recallOf(keys, kept.map((s) => s.text)), kept: kept.length, dropped: dropped.length, failure: a.failure ?? null,
      served_by: a.served_by ?? null, kept_text: kept.map((s) => s.text), dropped_text: dropped.map((s) => s.text), dropped_why: dropped.map((s) => s.dropped_because) });
    console.log(`${m}\t${seconds.toFixed(1)}s\tkept ${kept.length}\tleft out ${dropped.length}\tfacts ${recallOf(keys, kept.map((s) => s.text))}/${keys.length}${a.failure ? "\tFAILED " + a.failure : ""}\t${q}`);
    // Written after every answer, so a long run can be read while it runs: a pipe holds printed lines
    // in a buffer until the process ends, and a watch on it saw nothing for 30 minutes (2026-09-30).
    if (val("out")) writeFileSync(val("out"), JSON.stringify(rows, null, 2));
  }
}
rec.db.close();

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };
console.log(`\n${QUESTIONS.length} questions x ${runs} run(s). Kept and left out are per run, as min to max across runs.`);
console.log("model\tfinished\trecall\tkept\tleft out\tkept share\tmedian s\tmemory GB");
const ranked = [], unranked = [];
for (const m of models) {
  const r = rows.filter((x) => x.model === m);
  const perRun = Array.from({ length: runs }, (_, i) => r.filter((x) => x.run === i + 1));
  const finished = perRun.map((x) => x.filter((y) => !y.failure).length);
  const kept = perRun.map((x) => x.reduce((n, y) => n + y.kept, 0));
  const left = perRun.map((x) => x.reduce((n, y) => n + y.dropped, 0));
  const span = (xs) => (Math.min(...xs) === Math.max(...xs) ? `${xs[0]}` : `${Math.min(...xs)} to ${Math.max(...xs)}`);
  const k = kept.reduce((a, b) => a + b, 0), l = left.reduce((a, b) => a + b, 0);
  const found = r.reduce((n, y) => n + (y.found ?? 0), 0), keyed = r.reduce((n, y) => n + (y.keys ?? 0), 0);
  const line = `${m}\t${span(finished)} of ${QUESTIONS.length}\t${keyed ? Math.round((100 * found) / keyed) : 0}%\t${span(kept)}\t${span(left)}\t` +
    `${k + l ? Math.round((100 * k) / (k + l)) : 0}%\t${median(r.filter((x) => !x.failure).map((x) => x.seconds)).toFixed(1)}\t` +
    `${Math.max(0, ...r.map((x) => x.memory_gb ?? 0)) || "-"}`;
  (Math.min(...finished) >= Math.ceil(QUESTIONS.length * 5 / 6) ? ranked : unranked).push(line);
}
ranked.forEach((l) => console.log(l));
if (unranked.length) {
  console.log("\nNOT RANKED: finished fewer than five in six of the questions in a run, so its counts would flatter it.");
  unranked.forEach((l) => console.log(l));
}
const out = val("out");
if (out) writeFileSync(out, JSON.stringify(rows, null, 2));
