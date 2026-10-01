#!/usr/bin/env node
/**
 * Remove each guard, one at a time, and require a test to notice.
 *
 * The plan's section 3 says "a deletion pass removes each guard and confirms its test fails", and
 * until now that was true of the document senses and the five gates and NOT of the TypeScript. A
 * guard nobody has deleted is a guard nobody has checked: a sibling in this tree deleted fifteen
 * and found three that nothing noticed, all in the same layer.
 *
 * Each entry names a file, the exact text of a guard, and what to replace it with so the guard
 * stops guarding. The file is restored afterwards whatever happens.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const GUARDS = [
  {
    name: "the data directory must carry a confirmation marker",
    file: "src/util/paths.ts",
    find: "  if (!existsSync(marker)) {",
    with: "  if (false) {",
  },
  {
    name: "the person is told when the folder is inside a git repository",
    file: "src/util/paths.ts",
    find: "  if (git) {",
    with: "  if (false && git) {",
  },
  {
    name: "the person is told when the folder syncs",
    file: "src/util/paths.ts",
    find: "  if (synced) {",
    with: "  if (false && synced) {",
  },
  {
    name: "a confirmed folder carries a .gitignore",
    file: "src/record/db.ts",
    find: 'if (!existsSync(ignore)) writeFileSync(ignore, "*\\n");',
    with: "",
  },
  {
    name: "an existing .gitignore is never replaced",
    file: "src/record/db.ts",
    find: "if (!existsSync(ignore)) writeFileSync",
    with: "if (true) writeFileSync",
  },
  {
    name: "a file is read only when its reading finished",
    file: "src/ui/folder.ts",
    find: "  if (!run) return \"not read\";",
    with: "  if (!run) return \"read\";",
  },
  {
    name: "a file that could not be read is not queued again on every refresh",
    file: "src/ui/folder.ts",
    find: "if (q.failed.includes(path))",
    with: "if (false)",
  },
  {
    name: "leaving out removes other documents' quotes of it",
    file: "src/record/remove.ts",
    find: '      rec.db.prepare("DELETE FROM changes WHERE now_document_id = ? OR then_document_id = ?").run(doc.id, doc.id);',
    with: "",
  },
  {
    name: "leaving out compacts the file, so the text leaves the disk",
    file: "src/record/remove.ts",
    // Re-anchored 2026-09-30, when the compaction became compact(), shared with deleting a
    // conversation; the runner reported the old anchor as a miss rather than a pass.
    find: "  if (doc) compact(rec);",
    with: "",
  },
  {
    name: "a left-out file is not read again",
    file: "src/ui/folder.ts",
    find: '    if (d && leftOut.get(d)) return { ...base, state: "left out" };',
    with: "",
  },
  {
    name: "a question limited to one document searches only that document",
    file: "src/answer/retrieve.ts",
    find: "WHERE pages_fts MATCH ? AND (? IS NULL OR p.document_id = ?)",
    with: "WHERE pages_fts MATCH ? AND (1 OR ? IS NULL OR p.document_id = ?)",
  },
  {
    name: "a saved conversation keeps its turns",
    file: "src/record/conversations.ts",
    find: "    turns.forEach((t, i) => insert.run(cid, i, t.asked_at, t.question, JSON.stringify(t.answer ?? null)));",
    with: "",
  },
  {
    name: "deleting a saved conversation compacts the file, so its questions leave the disk",
    file: "src/record/conversations.ts",
    find: "  rec.db.prepare(\"DELETE FROM conversations WHERE id = ?\").run(id);\n  compact(rec);",
    with: "  rec.db.prepare(\"DELETE FROM conversations WHERE id = ?\").run(id);",
  },
  {
    name: "a folder saves no conversation unless switched on",
    file: "src/record/conversations.ts",
    find: "get(SETTING)?.value === \"all\";",
    with: "get(SETTING)?.value !== \"off\";",
  },
  {
    name: "a follow-up searches with the earlier question's words",
    file: "src/answer/answer.ts",
    find: "    : [earlier.at(-1)!.question, question].join(\" \").trim();",
    with: "    : question;",
  },
  {
    name: "text is judged at the size it is drawn, not the size its font was set",
    file: "src/screen/hidden.ts",
    find: "  const drawn = s.size * s.tmScale * scaleOf(s.ctm);",
    with: "  const drawn = s.size;",
  },
  {
    name: "white text over a painted shape is visible",
    file: "src/screen/hidden.ts",
    find: "  if (isWhite(s.fill) && !onShape) {",
    with: "  if (isWhite(s.fill)) {",
  },
  {
    name: "an agenda item number is never compared across meetings",
    file: "src/change/compare.ts",
    find: "      if (LOCAL_KINDS.has(id.kind)) continue;",
    with: "",
  },
  {
    name: "a document is compared only with documents added before it",
    file: "src/change/compare.ts",
    find: "        WHERE d.id != me.id AND (d.added_at < me.added_at OR (d.added_at = me.added_at AND d.id < me.id))",
    with: "        WHERE d.id != me.id",
  },
  {
    name: "a numbered agenda item ends the unit a date is paired within",
    file: "src/change/patterns.ts",
    find: "  const boundary = /\\n\\s*\\n|\\n[ \\t]*\\d{1,2}\\.[ \\t]/g;",
    with: "  const boundary = /\\n\\s*\\n/g;",
  },
  {
    name: "a resolution number keeps every segment",
    file: "src/change/patterns.ts",
    find: "(?:[-‑/][0-9]{1,4}){0,3})/gi],",
    with: "(?:[-‑/][0-9]{1,4})?)/gi],",
  },
  {
    name: "a sentence stating an outcome needs that word on its page",
    file: "src/answer/answer.ts",
    find: "  for (const m of text.matchAll(OUTCOME)) {",
    with: "  for (const m of ([] as RegExpMatchArray[])) {",
  },
  {
    name: "a quote under the length floor is refused",
    file: "src/quote/locator.ts",
    find: "  if (q.length < MIN_QUOTE_CHARS) {",
    with: "  if (false) {",
  },
  {
    name: "an ellipsis crossing a sentence is refused",
    file: "src/quote/locator.ts",
    // Re-anchored 2026-09-22: the check became `sentenceEndsIn` when the abbreviation and
    // closing-bracket rules were added, and this entry went on naming the old constant. The runner
    // reported that as a MISS rather than a pass, which is the only reason it was found.
    find: "    if (sentenceEndsIn(between)) {",
    with: "    if (false) {",
  },
  {
    name: "a hyphen at a line break is not a difference",
    file: "src/quote/locator.ts",
    find: '      if (norm.endsWith("-") && /^\\s*\\n/.test(source.slice(i))) {',
    with: "      if (false) {",
  },
  {
    name: "opening a record re-checks refusals stored before a locator fix",
    file: "src/record/db.ts",
    find: "  recheckRefusals(db);",
    with: "",
  },
  {
    name: "without a cloud key nothing is sent",
    file: "src/cloud/openrouter.ts",
    find: "  if (!o.key) {",
    with: "  if (false) {",
  },
  {
    name: "a cloud reply cut off at its length limit is a failure",
    file: "src/cloud/openrouter.ts",
    find: '  if (choice?.finish_reason === "length") {',
    with: "  if (false) {",
  },
  {
    name: "a model choice that cannot be right is refused before anything is sent",
    file: "src/harness/choose.ts",
    find: "  if (wrong) {\n    return async () =>",
    with: "  if (false) {\n    return async () =>",
  },
  {
    name: "an invented name opening a sentence is refused",
    file: "src/answer/answer.ts",
    find: "!DISCOURSE.has(word)) {",
    with: "!DISCOURSE.has(word) && false) {",
  },
  {
    name: "a quote appearing twice is ambiguous",
    file: "src/quote/locator.ts",
    find: "    if (hits.length > 1) {",
    with: "    if (false) {",
  },
  {
    name: "a sentence with no receipt is dropped",
    file: "src/answer/answer.ts",
    find: '  if (!cited.length) return { ok: false, why: "no receipt: the sentence cited no passage" };',
    with: "  if (false) return { ok: false, why: 'unreachable' };",
  },
  {
    name: "a number the passages lack drops the sentence",
    file: "src/answer/answer.ts",
    // Re-anchored 2026-09-22: the substring check became a comparison of VALUE SETS, after a
    // receipt check passed four fabrications by matching "1" inside "p1".
    find: "    if (have.has(v)) continue;",
    with: "    if (true) continue;",
  },
  {
    name: "a date the passages lack drops the sentence",
    file: "src/answer/answer.ts",
    find: "    if (!haveDates.has(d.iso)) {",
    with: "    if (false) {",
  },
  {
    name: "a name the passages lack drops the sentence",
    file: "src/answer/answer.ts",
    find: "    if (!flat.includes(word)) {",
    with: "    if (false) {",
  },
  {
    name: "a heading is excluded from figure pairing",
    file: "src/change/compare.ts",
    find: "        if (onHeadingLine(row.text, f.start)) continue;",
    with: "        if (false) continue;",
  },
  {
    name: "coverage is not complete when a window failed or was never reached",
    file: "src/change/compare.ts",
    find: "    complete: pagesUnread.length === 0 && windowsFailed === 0 && windowsShort <= 0,",
    with: "    complete: pagesUnread.length === 0,",
  },
  {
    name: "a prompt the runtime shortened is reported as truncated",
    file: "src/harness/model.ts",
    find: "  if (usage.prompt_eval_count > 0 && usage.prompt_eval_count < estimated * TRUNCATION_MARGIN) {",
    with: "  if (false) {",
  },
  {
    name: "a page with no text layer is not treated as read",
    file: "src/ingest/pipeline.ts",
    find: "    if (!p.has_text_layer) continue;",
    with: "    if (false) continue;",
  },
  {
    name: "OCR text is recorded as coming from OCR",
    file: "src/extract/ocr.ts",
    find: "    \"UPDATE pages SET text = ?, chars = ?, text_source = 'ocr', ocr_engine = ? WHERE document_id = ? AND page_no = ?\",",
    with: "    \"UPDATE pages SET text = ?, chars = ?, text_source = 'extracted', ocr_engine = ? WHERE document_id = ? AND page_no = ?\",",
  },
  {
    // The order in intake is load-bearing: a page OCR has not read yet has no text, and a vote
    // detector run over no text finds no votes and reports zero rather than reporting unread.
    // This is the defect the desktop shell actually shipped with until 2026-09-22.
    name: "the votes are read AFTER OCR, not before it",
    file: "src/ingest/intake.ts",
    find: "  const votes = readVotes(rec, added.document_id);",
    with: "  const votes = added.pages_with_text ? readVotes(rec, added.document_id) : 0;",
  },
  {
    // Invariant 6 is a NEGATIVE property: it holds because nothing writes the question anywhere.
    // A deletion cannot remove something that is not there, so this guard ADDS the write instead,
    // which is the shape a future query cache or recent-questions list would take. If
    // test/retention.test.ts does not notice, the product's central privacy claim is unchecked.
    name: "no part of a question reaches the data directory",
    file: "src/answer/answer.ts",
    // Re-anchored 2026-09-23. The line this named was rewritten hours earlier when retrieval
    // started reporting which half of it ran, and this entry went on naming code that was gone.
    // The runner reported it as a MISS rather than a pass, which is the only reason the guard on
    // this project's central privacy property did not quietly stop checking anything.
    // Re-anchored again 2026-09-30, when Ask gained a scope and this call took an options object.
    // Re-anchored 2026-09-30 again, when follow-up questions searched with the earlier words too,
    // and a third time that day, when an answer's passages became ANSWER_PASSAGES.
    find: "  const got = await retrieveHybridReporting(db, searchFor, { limit: opts.limit ?? ANSWER_PASSAGES, documentId: opts.documentId });",
    // The planted write is a saved conversation nobody asked for, the shape a careless auto-save takes.
    with: "  db.prepare('INSERT INTO conversations (started_at, title) VALUES (?, ?)').run(new Date().toISOString(), question);\n  const got = await retrieveHybridReporting(db, searchFor, { limit: opts.limit ?? ANSWER_PASSAGES, documentId: opts.documentId });",
  },
  {
    // Invariant 9's first half: the mark exists at all.
    name: "instruction-shaped text in a packet is marked",
    file: "src/screen/marks.ts",
    find: "      for (const s of screenInstructions(p.text, p.page_no)) {",
    with: "      for (const s of [] as ReturnType<typeof screenInstructions>) {",
  },
  {
    // Invariant 9's second half, and the one no text-layer reader can do.
    name: "text a reader cannot see is marked",
    file: "src/screen/marks.ts",
    find: "  const runs = bytes ? await hiddenText(bytes, new Map(pages.map((p) => [p.page_no, p.text]))) : [];",
    with: "  const runs: Awaited<ReturnType<typeof hiddenText>> = [];",
  },
  {
    // The half that is easy to get backwards. If marking ever started removing, this must fail.
    name: "a mark does not remove the text it marks",
    file: "src/screen/instructions.ts",
    find: "      hits.push({ rule, start, end: start + raw.length });",
    with: "      if (rule.kind !== \"suppresses-output\") hits.push({ rule, start, end: start + raw.length });",
  },
  {
    name: "nothing is checked for updates at launch unless it was switched on",
    file: "src/ui/updates.ts",
    find: "  if (!settings.checkAtLaunch) return null;",
    with: "  if (false) return null;",
  },
  {
    name: "a folder is confirmed only when the person approves it",
    file: "src/ui/choose.ts",
    find: "  if (!(await dialogs.approve(folder, verdict))) return { ok: false, cancelled: true };",
    with: "  void (await dialogs.approve(folder, verdict));",
  },
  {
    name: "a folder confirming would refuse is never offered for approval",
    file: "src/ui/choose.ts",
    find: "  if (!verdict.ok) return { ok: false, cancelled: false, verdict };",
    with: "  if (false) return { ok: false, cancelled: false, verdict };",
  },
  {
    name: "documents added in the shell are read one at a time",
    file: "src/ingest/queue.ts",
    find: "    if (current) return;",
    with: "    if (false) return;",
  },
  {
    name: "an intake that fails mid-reading closes its own run",
    file: "src/record/runs.ts",
    find: "  if (open) {",
    with: "  if (false) {",
  },
  {
    name: "re-reading a document replaces its votes rather than adding to them",
    file: "src/ingest/intake.ts",
    find: "    rec.db.prepare(\"DELETE FROM votes WHERE document_id = ?\").run(documentId);",
    with: "    void documentId;",
  },
  {
    name: "an update's checksum list must carry the release key's signature",
    file: "src/download/install.ts",
    find: "    if (!verifyChecksums(list, signature, key)) {",
    with: "    if (false) {",
  },
  {
    name: "an update's disk image must match its signed checksum",
    file: "src/download/install.ts",
    find: "    if (got !== want) return refuse(",
    with: "    if (false) return refuse(",
  },
  {
    name: "an update must be signed by the running app's Apple team",
    file: "src/download/install.ts",
    find: "    if (theirs !== ours) return refuse(",
    with: "    if (false) return refuse(",
  },
  {
    name: "an update must be newer than the running app",
    file: "src/download/install.ts",
    find: "    if (cmp >= 0) return refuse(",
    with: "    if (false) return refuse(",
  },
  {
    name: "a failed swap puts the old app back",
    file: "src/download/install.ts",
    find: "      rename(previous, bundle);\n      return refuse(",
    with: "      return refuse(",
  },
  {
    name: "Install is not offered from a disk image",
    file: "src/download/install.ts",
    find: 'if (a.bundle.startsWith("/Volumes/") || a.bundle.includes("/AppTranslocation/")) {',
    with: "if (false) {",
  },
];

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
let caught = 0;
const missed = [];

for (const g of GUARDS) {
  if (only && !g.name.includes(only)) continue;
  const path = join(ROOT, g.file);
  const original = readFileSync(path, "utf8");
  if (!original.includes(g.find)) {
    missed.push({ ...g, why: "the guard's text is not in the file any more, so this entry checks nothing" });
    console.log(`STALE  ${g.name}`);
    continue;
  }
  writeFileSync(path, original.replace(g.find, g.with));
  let failed = false;
  try {
    execSync("npx tsc -p tsconfig.json && node scripts/copy-assets.mjs", { cwd: ROOT, stdio: "pipe" });
    // The binary running this pass, which is Electron as Node: the one native build (package.json).
    execSync(`"${process.execPath}" --test "dist/test/**/*.test.js"`, { cwd: ROOT, stdio: "pipe" });
  } catch {
    failed = true;
  } finally {
    writeFileSync(path, original);
  }
  if (failed) {
    caught++;
    console.log(`caught  ${g.name}`);
  } else {
    missed.push({ ...g, why: "every test still passed with the guard gone" });
    console.log(`MISSED  ${g.name}  (${g.file})`);
  }
}

execSync("npx tsc -p tsconfig.json && node scripts/copy-assets.mjs", { cwd: ROOT, stdio: "pipe" });

/*
 * The result is WRITTEN, with the date it ran, because it is the one number in the headline that
 * cannot be derived from a file: it is what happened, not what exists.
 *
 * It is written here because on 2026-09-22 a STATUS headline claimed "17 of 17 guards caught"
 * before this pass had finished, and the pass then came back 14 of 17. A number a person types
 * from memory of a run that is still going is the failure this whole file argues against.
 */
// ONLY a full pass is recorded. A --only run is a subset, and the first version wrote it anyway:
// running one guard left behind "1 of 1 caught", which the headline generator then printed beside
// "and there are 21 guards now". The generator caught it, which is the mechanism working, and the
// recorder should not have produced it. A partial run is not a result about the guards.
if (!only) {
  writeFileSync(
    join(ROOT, "docs", "deletion-pass.json"),
    JSON.stringify({ caught, total: caught + missed.length, ran: new Date().toISOString().slice(0, 10) }, null, 1) + "\n",
  );
} else {
  console.log(`\n(--only ran a subset, so docs/deletion-pass.json is left alone)`);
}
console.log(`\n${caught} of ${caught + missed.length} guards were noticed when deleted.`);
for (const m of missed) console.log(`  MISSED: ${m.name} in ${m.file}: ${m.why}`);
process.exit(missed.length ? 1 : 0);
