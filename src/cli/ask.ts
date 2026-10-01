/**
 * Ask the record a question, and see the passage under every sentence.
 *
 *   npm run ask -- --dir <data dir> "what changed about the substation contract?"
 *   npm run ask -- --dir <data dir> --search "substation"     (no model, raw passages)
 *   npm run ask -- --dir <data dir> --brief <document id>     (no model at all)
 */
import { argv, exit } from "node:process";
import { openRecord, LocationRefused } from "../record/db.js";
import { answer } from "../answer/answer.js";
import { retrieve } from "../answer/retrieve.js";
import { buildBrief, renderBrief } from "../brief/brief.js";
import { describeRuns } from "../record/runs.js";
import { listRefusals, review, summarise } from "../quote/refusals.js";
import { isUp, RUNTIME_ORIGIN, startRuntime } from "../harness/runtime.js";
import { GENERAL_MODEL } from "../harness/model.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}

const dir = arg("dir");
if (!dir) {
  console.error("--dir is required");
  exit(2);
}
const model = arg("model", GENERAL_MODEL)!;

let rec;
try {
  rec = openRecord(dir);
} catch (e) {
  if (e instanceof LocationRefused) {
    console.error(e.message);
    exit(1);
  }
  throw e;
}

if (argv.includes("--runs")) {
  const runs = describeRuns(rec.db);
  if (!runs.length) console.log("No run has been recorded in this record.");
  for (const r of runs) {
    const mark = r.state === "running" ? "*" : r.state === "finished" ? " " : "!";
    console.log(`${mark} run ${r.id}  ${r.filename}  ${r.model}  started ${r.started_at.replace("T", " ").slice(0, 19)}`);
    console.log(`  ${r.says}`);
  }
  rec.db.close();
  exit(0);
}

if (argv.includes("--refusals")) {
  const doc = arg("document");
  const s = summarise(rec.db, doc ? Number(doc) : undefined);
  console.log(s.says);
  for (const v of s.by_verdict) console.log(`  ${v.verdict}: ${v.n}   points at ${v.points_at}`);
  console.log(`\n${s.rate}`);
  if (s.total) {
    console.log("\nRead them, then record what you found:");
    console.log("  npm run ask -- --dir <dir> --review <id> right|wrong [--note \"...\"]\n");
    for (const r of listRefusals(rec.db, doc ? Number(doc) : undefined, argv.includes("--unread"), 20)) {
      const mark = r.reviewed_verdict ? (r.reviewed_verdict === "right" ? "[gate right]" : "[GATE WRONG]") : "[unread]";
      console.log(`${mark} ${r.id}  window ${r.window_no}  ${r.verdict}: ${r.reason}`);
      console.log(`    claim: ${r.claim_text.slice(0, 100)}`);
      console.log(`    quote: ${r.quote.slice(0, 100)}`);
    }
  }
  rec.db.close();
  exit(0);
}

const reviewId = arg("review");
if (reviewId) {
  const verdict = argv[argv.indexOf("--review") + 2];
  if (verdict !== "right" && verdict !== "wrong") {
    console.error('--review <id> must be followed by "right" or "wrong"');
    exit(2);
  }
  review(rec.db, Number(reviewId), verdict, arg("note", "")!);
  console.log(`refusal ${reviewId}: the gate was ${verdict}`);
  rec.db.close();
  exit(0);
}

const briefFor = arg("brief");
if (briefFor) {
  console.log(renderBrief(buildBrief(rec.db, Number(briefFor))));
  rec.db.close();
  exit(0);
}

const question = argv.slice(2).filter((a) => !a.startsWith("--") && a !== dir && a !== model).join(" ").trim();
if (!question) {
  console.error('a question is required, in quotes: ask.js --dir <dir> "what changed?"');
  exit(2);
}

if (argv.includes("--search")) {
  const passages = retrieve(rec.db, question, 10);
  if (!passages.length) console.log("Nothing in the record matched those words.");
  for (const p of passages) {
    console.log(`\n[${p.id}] ${p.filename} page ${p.page_no}`);
    console.log(p.text.slice(0, 600).replace(/\s+/g, " ").trim());
  }
  console.log("\nRaw passages, ranked by the words you used. No model was asked.");
  rec.db.close();
  exit(0);
}

if (!(await isUp())) {
  console.log(`the runtime is not answering on ${RUNTIME_ORIGIN}; starting it`);
  await startRuntime();
}

const a = await answer(rec.db, question, { model });
if (a.failure) {
  console.log(`No answer: ${a.failure}`);
  console.log(a.note);
} else {
  for (const s of a.sentences) {
    console.log(`\n${s.kept ? "  " : "x "}${s.text}`);
    if (!s.kept) {
      console.log(`   dropped: ${s.dropped_because}`);
      continue;
    }
    for (const r of s.receipts) {
      const p = a.passages.find((x) => x.id === r);
      if (!p) continue;
      console.log(`   [${p.id}] ${p.filename} page ${p.page_no}`);
      console.log(`   ${p.text.slice(0, 400).replace(/\s+/g, " ").trim()}`);
    }
  }
}
console.log(`\n${a.note}`);
rec.db.close();
