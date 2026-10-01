/**
 * Add a document and read it. The work happens when a packet arrives, not when a question is asked.
 *
 *   npm run ingest -- --dir <data dir> --file <path> [--layer public|private] [--no-model]
 *   npm run ingest -- --dir <data dir> --confirm      (the deliberate act, once)
 */
import { argv, exit } from "node:process";
import { openRecord, confirmLocation, LocationRefused } from "../record/db.js";
import { intake } from "../ingest/intake.js";
import { listMarks } from "../screen/marks.js";
import { GENERAL_MODEL } from "../harness/model.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}

const dir = arg("dir");
if (!dir) {
  console.error("--dir is required. It is never inside this repository, a synced folder or a git tree.");
  exit(2);
}

if (argv.includes("--confirm")) {
  try {
    confirmLocation(dir, "the person at this keyboard");
    console.log(`confirmed: ${dir}`);
    exit(0);
  } catch (e) {
    console.error((e as Error).message);
    exit(1);
  }
}

const file = arg("file");
const layer = (arg("layer", "public") as "public" | "private") ?? "public";
const model = arg("model", GENERAL_MODEL)!;
const noModel = argv.includes("--no-model");

let rec;
try {
  rec = openRecord(dir);
} catch (e) {
  if (e instanceof LocationRefused) {
    console.error(e.message);
    console.error("\nIf this location is the one you want, run with --confirm once.");
    exit(1);
  }
  throw e;
}

if (!file) {
  console.error("--file is required unless --confirm was given");
  exit(2);
}

const result = await intake(rec, file, {
  layer,
  meeting: arg("meeting"),
  date: arg("date"),
  model: noModel ? undefined : model,
  onStep: (note) => console.log(note),
  onProgress: (p) =>
    process.stdout.write(
      `\r  window ${p.window_no}/${p.windows_total}  kept ${p.kept}  refused ${p.refused}` +
        (p.failure ? `  FAILED: ${p.failure}` : "          "),
    ),
});
const { added, ingest } = result;

if (result.ocr && result.ocr.pages_still_unread.length) {
  console.log(
    `  ${result.ocr.pages_still_unread.length} page(s) had no extractable text and are UNREAD, not unchanged: ${result.ocr.note}`,
  );
}

if (ingest) {
  process.stdout.write("\n");
  console.log(
    `  read by ${model}: ${ingest.windows_completed}/${ingest.windows_total} windows in ${ingest.seconds.toFixed(1)}s` +
      (ingest.windows_failed ? `, ${ingest.windows_failed} failed (${ingest.failure_kinds.join(", ")})` : "") +
      `\n  claims kept ${ingest.claims_kept}, refused ${ingest.claims_refused}, windows not covered ${ingest.not_covered}`,
  );
}

// Invariant 9's marks, printed in full rather than counted, because a count points nowhere: the
// only question worth answering is what the packet actually says to a machine.
if (result.screen.instructions || result.screen.hidden) {
  console.log(`\nMARKED IN THIS PACKET`);
  console.log(`  ${result.screen.note}`);
  for (const m of listMarks(rec.db, added.document_id)) {
    const what = m.kind === "hidden" ? "not visible to a reader" : "reads as an instruction";
    const both = m.also_hidden ? "  AND IS HIDDEN FROM A READER" : "";
    console.log(`  page ${m.page_no}  ${what}${both}  (${m.reason}${m.detail ? ", " + m.detail : ""})`);
    console.log(`    ${m.text.slice(0, 160)}`);
    console.log(`    ${m.reached_the_record ? "IS in the page text this record holds" : "did not reach the page text"}`);
  }
}

const cr = result.change;
console.log(`\nCHANGE RECORD #${result.change_record_id}`);
console.log(`  coverage: ${cr.coverage.note}`);
console.log(`  compared against ${cr.compared_against} earlier document(s)`);
for (const kind of ["new_identifier", "moved_figure", "moved_date", "recurrence"] as const) {
  const rows = cr.changes.filter((c) => c.kind === kind);
  if (!rows.length) continue;
  console.log(`  ${kind}: ${rows.length}`);
  for (const r of rows.slice(0, 6)) {
    const detail = kind === "recurrence" ? `seen in ${r.count} documents` : `${r.then_value} -> ${r.now_value}`;
    console.log(`    ${r.subject}  ${detail}`);
  }
}
rec.db.close();
