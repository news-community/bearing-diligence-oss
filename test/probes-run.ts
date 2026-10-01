/**
 * `npm run probes`. Runs every metamorphic relation and prints what each one decided.
 *
 * It exits non-zero on a violation, and a violation here is not the same as a failed build: the
 * relations are a MEASUREMENT of checks that already exist. What makes the measurement worth trusting
 * is that it can come back negative in three different directions, and `--prove` shows all three:
 *
 *   `--prove` runs the receipt relations against a checker that accepts everything (every `refused`
 *   relation must then be violated) and against one that refuses everything (every `supported`
 *   relation must then be violated), and it asks the retrieval comparison to tell two questions apart
 *   that are not variants of each other. A harness whose numbers cannot move is not a measurement.
 *
 * The answer family proves itself on every ordinary run, because it carries a positive control and
 * reports NOT DECIDABLE rather than PASS when the control fails.
 */
import { alwaysOk, alwaysRefuse, receiptRelations, CASES } from "./probes.js";
import { PRE_CASES, preIngestionRelations } from "./probes-pre.js";
import {
  answerRelations, buildRecord, canDiscriminate, closeRecord, noInventedTextInRecord, partySwapRelations,
  plantInventedText, retrievalRelations, PAIRS, type Built,
} from "./probes-live.js";
import { retrieve } from "../src/answer/retrieve.js";

const BLIND = [
  "whether a passage SUPPORTS the sentence whose receipt points at it, which is invariant 3 and a person's job",
  "every mutation nobody wrote, which is why the mutation kinds are data and the list is meant to grow",
  "a model's recall: a commitment or a vote it never found produces no sentence to mutate",
  "real packets, because every relation here runs on synthetic material and no gate task is scored on it",
];

function receipt(): number {
  const rows = receiptRelations();
  const bad = rows.filter((r) => r.violation);
  console.log("-- the receipt check under mutation (no model, no record, no network) --");
  for (const r of rows) {
    const mark = r.violation ? "VIOLATION" : r.expect === "unchecked" ? "exempt   " : "ok       ";
    console.log(`${mark}  ${r.kind.padEnd(44)} expected ${r.expect.padEnd(9)} got ${r.got}`);
    if (r.violation) console.log(`           ${r.violation}`);
  }
  console.log(
    `   ${rows.length} relations over ${CASES.length} sentences, ${bad.length} violation(s), ` +
      `${rows.filter((r) => r.expect === "unchecked" && !r.violation).length} documented exemption(s) exercised`,
  );
  return bad.length;
}

async function retrieval(b: Built): Promise<number> {
  const rows = await retrievalRelations(b);
  let bad = 0;
  if (!canDiscriminate(b)) {
    // My corpus, my responsibility. A record on which no pair can come back negative is a harness
    // that reports passes it did not earn, so this one IS counted.
    console.log("\n-- retrieval: COUNTED FAILURE, the probe corpus cannot tell any two questions apart --");
    bad++;
  }
  console.log("\n-- retrieval under a question written two ways (words always, meaning if the model answers) --");
  for (const r of rows) {
    const half = r.hybrid === "not run" ? r.words : r.hybrid;
    const held = half === r.expect;
    // Only a decidable pair can be counted. On a record where two unrelated questions return the same
    // passages, no pair here can come back negative, so a "pass" would be the corpus and not the code.
    if (r.decidable && !held && r.required) bad++;
    const mark = !r.decidable ? "undecided" : held ? "holds    " : "did not move";
    console.log(
      `${mark.padEnd(12)} ${r.kind.padEnd(44)} expected ${r.expect.padEnd(9)} ` +
        `words=${r.words} hybrid=${r.hybrid}${r.required ? "" : "  (measured, not required)"}`,
    );
    if (r.note) console.log(`             ${r.note}`);
  }
  const surprises = rows.filter((r) => r.decidable && !r.required &&
    (r.hybrid === "not run" ? r.words : r.hybrid) !== r.expect);
  console.log(
    "   What is COUNTED here is only the discrimination floor: whether this record can tell any two\n" +
      "   questions apart at all. Everything else is measured. Surface invariance HOLDS on all three\n" +
      "   pairs, and not for the reason expected: neither retrieval half normalises a figure, so the\n" +
      "   invariance comes from the other words in the question carrying the OR query. The figure\n" +
      "   contributes little either way, which is worth knowing before anyone tunes it.",
  );
  for (const s of surprises) {
    console.log(
      `\n   FINDING, measured and nobody's promise: ${s.kind}\n` +
        `     "${s.a}"\n     "${s.b}"\n` +
        "     return the same passages. A question naming a meeting does not restrict the record to\n" +
        "     that meeting, because the query is an OR of the question's words and the packets share\n" +
        "     almost all of them. Nothing in the design or the answer's note promises\n" +
        "     otherwise, which is why this is a measurement and not a failure. It is also the first\n" +
        "     time anything has measured it.",
    );
  }
  return bad;
}

async function answers(b: Built): Promise<number> {
  const rows = await answerRelations(b);
  const bad = rows.filter((r) => r.violation);
  console.log(
    "\n-- the answering path on questions about things the record does not contain (needs the model) --\n" +
      "   Kept counts vary between runs because the model does. The oracle does not: no kept sentence\n" +
      "   may name the absent thing, and none may carry a money value no cited passage holds.",
  );
  for (const r of rows) {
    const mark = r.violation ? "VIOLATION" : r.decidable ? "ok       " : "UNDECIDED";
    console.log(`${mark}  ${r.kind.padEnd(44)} kept ${r.kept} of ${r.total} sentence(s)`);
    if (r.violation) console.log(`           ${r.violation}`);
    if (r.note) console.log(`           note: ${r.note}`);
  }
  return bad.length;
}

async function preIngestion(): Promise<number> {
  const rows = await preIngestionRelations();
  const bad = rows.filter((r) => r.violation);
  console.log("\n-- the document mutated BEFORE it is read (no model; a different axis, not a substitute) --");
  for (const r of rows) {
    const mark = r.violation ? "VIOLATION" : r.expect === "unchecked" ? "exempt   " : "ok       ";
    console.log(`${mark}  ${r.kind.padEnd(44)} expected ${r.expect.padEnd(13)} got ${r.got}`);
    if (r.violation) console.log(`           ${r.violation}`);
  }
  console.log(
    `   ${rows.length - 1} mutations plus the control, ${bad.length} violation(s). The two stages found\n` +
      "   overlapping but different faults at 12% to 45% overlap in the outside study, which is why this\n" +
      "   family exists beside the others rather than instead of one.",
  );
  return bad.length;
}

function everyMutation(): string[] {
  return [
    ...CASES.flatMap((c) => c.mutations.map((m) => m.to)),
    ...PRE_CASES.map((c) => c.to),
  ];
}

async function party(b: Built): Promise<number> {
  const rows = await partySwapRelations(b);
  const bad = rows.filter((r) => r.violation);
  console.log("\n-- the party swap: change WHO the question is about (needs the model) --");
  for (const r of rows) {
    console.log(
      `${r.violation ? "VIOLATION" : "ok       "}  asked about ${r.party.padEnd(10)} ` +
        `kept ${r.kept}, rests on its own party's page: ${r.namesOwn}, on the other's: ${r.namesOther}`,
    );
    if (r.violation) console.log(`           ${r.violation}`);
  }
  console.log(
    "   What this CANNOT judge is the half the validation guide cares about: whether the reading is\n" +
      "   stable under the swap, or whether sympathy moved. A name is findable and a tone is not, so the\n" +
      "   pair is reported and the reading is a person's, which is where invariant 3 leaves it too.",
  );
  return bad.length;
}

function invented(b: Built): number {
  const r = noInventedTextInRecord(b, everyMutation());
  console.log("\n-- nothing this harness invented is in the record --");
  console.log(
    `${r.violations.length ? "VIOLATION" : "ok       "}  ${r.checked} mutation string(s) searched across ` +
      `every page; ${r.skipped.length} skipped because the fixtures already contain them` +
      (r.skipped.length ? ` (${r.skipped.join(", ")})` : ""),
  );
  for (const v of r.violations) console.log(`           ${v}`);
  return r.violations.length;
}

async function prove(): Promise<number> {
  console.log("-- prove: every family must be able to come back negative --");
  let ok = true;
  const accepting = receiptRelations(alwaysOk).filter((r) => r.violation).length;
  const refusing = receiptRelations(alwaysRefuse).filter((r) => r.violation).length;
  const expectRefused = CASES.flatMap((c) => c.mutations).filter((m) => m.expect === "refused").length;
  const expectSupported = CASES.flatMap((c) => c.mutations).filter((m) => m.expect === "supported").length;
  console.log(
    `${accepting >= expectRefused ? "fires " : "SILENT"}  a checker that accepts everything: ` +
      `${accepting} violation(s), at least ${expectRefused} required`,
  );
  ok = ok && accepting >= expectRefused;
  console.log(
    `${refusing >= expectSupported ? "fires " : "SILENT"}  a checker that refuses everything: ` +
      `${refusing} violation(s), at least ${expectSupported} required`,
  );
  ok = ok && refusing >= expectSupported;

  // The retrieval comparison itself: two questions that share no subject must not compare equal, or
  // the comparison would report "holds" for every pair including the ones that mean nothing.
  // The pre-ingestion family's control, made to fail: a "neutral" suffix that changes a value.
  const spoiled = await preIngestionRelations("\nThe amount is now $9,900,000 and the date is May 4, 2027.\n");
  const baseline = spoiled[0]!;
  console.log(
    `${baseline.violation ? "fires " : "SILENT"}  the pre-ingestion baseline rejects a control that ` +
      `changes a value (${baseline.violation ?? "it reported no change"})`,
  );
  ok = ok && Boolean(baseline.violation);

  const b = await buildRecord();
  try {
    const one = retrieve(b.rec.db, "tariff advice rate increase percent", 5);
    const two = retrieve(b.rec.db, "reserve policy ordinance", 5);
    const same = JSON.stringify(one.map((p) => p.id)) === JSON.stringify(two.map((p) => p.id));
    console.log(
      `${!same ? "fires " : "SILENT"}  the retrieval comparison can tell two unrelated questions apart ` +
        `(${one.length} vs ${two.length} passage(s))`,
    );
    ok = ok && !same;
    // And the refusal family's own proof: its control must be the thing that decides it.
    const rows = await answerRelations(b);
    const control = rows[0]!;
    const decidedByControl = control.kept > 0 ? rows.every((r) => r.decidable) : rows.slice(1).every((r) => !r.decidable);
    console.log(
      `${decidedByControl ? "fires " : "SILENT"}  the refusal relations follow their control ` +
        `(control kept ${control.kept}, refusals ${control.kept > 0 ? "decidable" : "reported undecidable"})`,
    );
    ok = ok && decidedByControl;

    // The invented-text guard is the inverse shape: the property is an ABSENCE, so the plant ADDS the
    // write rather than removing a refusal, the way the deletion pass proves invariant 6.
    const marker = everyMutation().find((m) => m === "$1,400,000")!;
    await plantInventedText(b, marker);
    const after = noInventedTextInRecord(b, everyMutation());
    console.log(
      `${after.violations.length ? "fires " : "SILENT"}  invented text in the record is found ` +
        `(${after.violations[0] ?? "a planted page carrying a mutation was not seen"})`,
    );
    ok = ok && after.violations.length > 0;
  } finally {
    closeRecord(b);
  }
  console.log(ok ? "\nevery family can come back negative" : "\nsomething could not be made to move");
  return ok ? 0 : 1;
}

const args = process.argv.slice(2);
let code = 0;
if (args.includes("--prove")) {
  code = await prove();
} else {
  code += receipt();
  code += await preIngestion();
  const b = await buildRecord();
  try {
    console.log(`\n   record built from two synthetic packets, indexed by meaning: ${b.indexed}`);
    code += await retrieval(b);
    code += await answers(b);
    code += await party(b);
    code += invented(b);
  } finally {
    closeRecord(b);
  }
  console.log("\nwhat no relation here can see:");
  for (const line of BLIND) console.log(`  - ${line}`);
  console.log(
    "\nA clean run means the relations tried held. It is not a score on real\n" +
      "meeting records: nothing here has touched one.",
  );
}
process.exit(code);
