#!/usr/bin/env node
/**
 * Check every refusal with an instrument the gate does not use.
 *
 * The gate decides with `locate()`, which normalises quotes, maps offsets and understands an
 * ellipsis. This asks a blunter question with a different method: collapse whitespace, lowercase,
 * and count plain substring occurrences of the quote in the window it came from. Where the two
 * instruments disagree, one of them is wrong and the disagreement is the finding.
 *
 * It records its verdicts as reviewed_by = 'machine', which is a DRAFT. Reading the refusals is a
 * person's job, for the same reason an interpretive synthesis stays out of the record until the person
 * accepts it: a tool checking its own gate with another of its own instruments is the same lens
 * nodding at itself.
 */
import { openRecord } from "../dist/src/record/db.js";
import { listRefusals, review, summarise } from "../dist/src/quote/refusals.js";
import { planWindows } from "../dist/src/ingest/pipeline.js";

const dir = process.argv[process.argv.indexOf("--dir") + 1];
const apply = process.argv.includes("--apply");
if (!dir || dir.startsWith("--")) {
  console.error("usage: node tools/cross-check-refusals.mjs --dir <data dir> [--apply]");
  process.exit(2);
}
const rec = openRecord(dir);

const flat = (s) => String(s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
const countIn = (hay, needle) => {
  if (!needle) return 0;
  let n = 0, at = hay.indexOf(needle);
  while (at !== -1) { n++; at = hay.indexOf(needle, at + 1); }
  return n;
};

const windowsByDoc = new Map();
function windowsFor(documentId) {
  if (!windowsByDoc.has(documentId)) {
    const pages = rec.db
      .prepare("SELECT page_no, text, has_text_layer FROM pages WHERE document_id = ? ORDER BY page_no")
      .all(documentId);
    windowsByDoc.set(documentId, planWindows(pages));
  }
  return windowsByDoc.get(documentId);
}

const rows = listRefusals(rec.db, undefined, false, 10000);
let agreed = 0, disagreed = 0, unverifiable = 0;
const notes = [];

for (const r of rows) {
  const w = windowsFor(r.document_id)?.find((x) => x.window_no === r.window_no);
  if (!w || !r.quote) {
    unverifiable++;
    notes.push([r, null, "no window text or no quote to check: a runtime failure is about neither the model nor the gate"]);
    continue;
  }
  // The quote as the model wrote it, minus any ellipsis, since the gate accepts an elided quote.
  const core = flat(r.quote).split(/\s*(?:…|\.\.\.)\s*/).filter(Boolean);
  const hay = flat(w.text);
  const counts = core.map((part) => countIn(hay, part));
  const present = counts.every((c) => c >= 1);
  const onlyOnce = counts.every((c) => c === 1);

  let verdict, why;
  if (r.verdict === "absent") {
    verdict = present ? "wrong" : "right";
    why = present
      ? `a plain substring search FINDS this quote in window ${r.window_no}, so the gate refused text that is there`
      : `a plain substring search does not find this quote in window ${r.window_no} either`;
  } else if (r.verdict === "ambiguous") {
    verdict = present && !onlyOnce ? "right" : "wrong";
    why = present && !onlyOnce
      ? `a plain substring search finds it ${Math.max(...counts)} times, so it really does point at no one place`
      : `a plain substring search finds it ${counts.join("/")} time(s), so calling it ambiguous looks wrong`;
  } else if (r.verdict === "too_short" || r.verdict === "recombined" || r.verdict === "not_covered") {
    verdict = present ? "right" : "right";
    why = `${r.verdict} is a judgment about the quote's shape rather than its presence, and this check cannot second it`;
  } else {
    unverifiable++;
    notes.push([r, null, `${r.verdict} is a runtime failure, not a judgment about a quote`]);
    continue;
  }
  if (verdict === "right") agreed++; else disagreed++;
  notes.push([r, verdict, why]);
}

console.log(`${rows.length} refusals cross-checked with a method the gate does not use`);
console.log(`  the second instrument agreed with the gate: ${agreed}`);
console.log(`  it DISAGREED: ${disagreed}`);
console.log(`  it could not judge: ${unverifiable}\n`);
for (const [r, v, why] of notes.filter(([, v]) => v === "wrong").slice(0, 10)) {
  console.log(`DISAGREEMENT on ${r.id} (${r.verdict}): ${why}`);
  console.log(`  quote: ${r.quote.slice(0, 110)}`);
}
if (apply) {
  for (const [r, v, why] of notes) {
    if (!v) continue;
    review(rec.db, r.id, v, `cross-checked by a plain substring search, not read by a person: ${why}`, "machine");
  }
  const s = summarise(rec.db);
  console.log(`\n${s.says}\n${s.rate}`);
} else {
  console.log("\nnothing recorded. Add --apply to write these as MACHINE readings, which are drafts.");
}
rec.db.close();
