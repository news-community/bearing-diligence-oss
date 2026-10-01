/**
 * What the record needs, what the runtime holds, and pulling what is missing.
 *
 *   npm run models                what is pinned, what is held, what this machine needs
 *   npm run models -- --pull      pull what this machine needs, each verified against its digest
 *   npm run models -- --pull --all   pull every pinned model, which is far more than anyone needs
 *
 * What a machine NEEDS is the reading model, the embedding model, and the default answering model
 * for its memory (src/ui/models.ts). Every other pinned model is optional, chosen in Settings. Until
 * 2026-10-01 this pulled every pinned model, which with seven answering models was about 170 GB.
 *
 * This exists because the download module had no caller at all. It was written, gated, and
 * unreachable from anything, which means the first time it ran would have been on a user's
 * machine. Running it here found two defects in it: a held model reported missing because the
 * runtime answers with `:latest`, and the embedding model absent from the manifest entirely while
 * the code had been using it since hybrid retrieval landed.
 *
 * It stays in src/cli/ rather than in the app because the gates keep the download module out of
 * ingestion and question time, and the shell is both.
 */
import { argv, exit } from "node:process";
import { missing, modelStates, pull } from "../download/pull.js";
import { EMBED_MODEL } from "../answer/embed.js";
import { GENERAL_MODEL } from "../harness/model.js";
import { bestLocal, localModels } from "../ui/models.js";
import { isUp, RUNTIME_ORIGIN, startRuntime } from "../harness/runtime.js";

if (!(await isUp())) {
  console.log(`the runtime is not answering on ${RUNTIME_ORIGIN}; starting it`);
  try {
    await startRuntime();
  } catch (e) {
    console.error((e as Error).message);
    exit(1);
  }
}

console.log("pinned in the manifest:");
for (const m of await modelStates()) {
  console.log(`  ${m.name.padEnd(20)} ${(m.size / 1e9).toFixed(2)} GB  ${m.state}`);
}

// The default answering model as if every pinned model were installed: the one this machine should have.
const asIfHeld = (await localModels()).map((m) => ({ ...m, held: true, matches: true }));
const needed = new Set([GENERAL_MODEL, EMBED_MODEL, bestLocal(asIfHeld)]);
const all = argv.includes("--all");
const gaps = (await missing()).filter((g) => all || needed.has(g.name));
const optional = (await missing()).filter((g) => !needed.has(g.name));
if (optional.length && !all) {
  console.log(`\noptional, chosen in Settings: ${optional.map((g) => g.name).join(", ")}`);
}
if (!gaps.length) {
  console.log(`\nnothing this machine needs is missing (${[...needed].join(", ")})`);
  exit(0);
}
console.log(`\n${gaps.length} needed and missing or mismatched:`);
for (const g of gaps) console.log(`  ${g.name}: ${g.reason}`);

if (!argv.includes("--pull")) {
  console.log("\nadd --pull to fetch them. That is the one time this application reaches the network,");
  console.log("it carries no question text and no document text, and every byte is verified against");
  console.log("the digest the manifest names.");
  exit(1);
}

let bad = 0;
for (const g of gaps) {
  const out = await pull(g.name);
  console.log(out.ok ? `  ${out.name}: ok${out.already_held ? " (already held)" : ""}` : `  ${out.name}: REFUSED, ${out.reason}`);
  if (!out.ok) bad++;
}
exit(bad ? 1 : 0);
