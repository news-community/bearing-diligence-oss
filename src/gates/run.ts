/**
 * Run every gate, and prove every gate can fail.
 *
 *   npm run gates                         every gate against this working tree
 *   npm run prove                         plant a failing case for each one; every one must fire
 *   dist/src/gates/run.js --json          machine readable, for scripts/checks.py to fold in
 *
 * There is one definition of "shown able to fail" in this repository, and this file and
 * scripts/checks.py both implement it. A second, weaker definition would win by being easier.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GATES, Gate, GateOpts } from "./gates.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");

type Planted = { root: string; opts?: GateOpts; cleanup: () => void; stale?: string };

/**
 * A plant is a new file (`body`) or an edit of a file already in the copied tree (`find` and
 * `with`, the deletion pass's shape). An edit is preferred: a plant that copies a whole file goes
 * stale the moment that file changes, and one did within a day of being written. An edit whose
 * `find` is no longer in the file is reported, never counted as firing, because a plant that no
 * longer applies proves nothing.
 */
type Plant = { path: string; body: string } | { path: string; find: string; with: string };

/**
 * One planted copy of the tree per case. A gate with two halves has two cases, and it fires only
 * when EVERY case fires, the rule scripts/checks.py already applies to a sense with two halves: a
 * gate proven on one branch says nothing about the other.
 */
function plantsFor(gate: Gate): Planted[] {
  // The planted bodies are DATA (plants.json), because written here they would be exactly what the
  // forbidden-reference gate looks for, and this runner would fail on its own failing cases.
  const plants = JSON.parse(readFileSync(join(HERE, "plants.json"), "utf8")) as Record<string, Plant | Plant[]>;
  const cases = plants[gate.name];
  return (cases === undefined ? [undefined] : Array.isArray(cases) ? cases : [cases]).map((plant) => {
    const dir = mkdtempSync(join(tmpdir(), "pr-gate-"));
    const cleanup = () => rmSync(dir, { recursive: true, force: true });
    cpSync(join(ROOT, "src"), join(dir, "src"), { recursive: true });
    if (gate.name === "tool list empty") return { root: dir, opts: { toolsOf: () => ["shell"] }, cleanup };
    // app/ and tools/ too. The gates have walked app/ since a review planted a beacon in the shipped
    // entry point and all five printed pass, and a gate over the two bridges has to see both of them.
    // A planted root missing the directory a gate reads makes that gate unprovable.
    for (const d of ["app", "tools"]) {
      if (existsSync(join(ROOT, d))) cpSync(join(ROOT, d), join(dir, d), { recursive: true });
    }
    if (plant && "body" in plant) {
      mkdirSync(dirname(join(dir, plant.path)), { recursive: true });
      writeFileSync(join(dir, plant.path), plant.body);
    } else if (plant) {
      const at = join(dir, plant.path);
      const text = existsSync(at) ? readFileSync(at, "utf8") : "";
      if (!text.includes(plant.find)) {
        return { root: dir, cleanup, stale: `the plant for ${plant.path} no longer applies: its text is not in the file` };
      }
      writeFileSync(at, text.replace(plant.find, plant.with));
    }
    return { root: dir, cleanup };
  });
}

function main(): number {
  const prove = process.argv.includes("--prove");
  const asJson = process.argv.includes("--json");
  const results: Array<{ name: string; sees: string; blind_to: string; findings: string[]; fired?: boolean }> = [];

  for (const gate of GATES) {
    if (!prove) {
      results.push({ name: gate.name, sees: gate.sees, blind_to: gate.blindTo, findings: gate.run(ROOT) });
      continue;
    }
    const findings: string[] = [];
    let fired = true;
    for (const planted of plantsFor(gate)) {
      try {
        if (planted.stale) {
          findings.push(planted.stale);
          fired = false;
          continue;
        }
        const got = gate.run(planted.root, planted.opts);
        findings.push(...got);
        fired &&= got.length > 0;
      } finally {
        planted.cleanup();
      }
    }
    results.push({ name: gate.name, sees: gate.sees, blind_to: gate.blindTo, findings, fired });
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(results, null, 1));
    return results.some((r) => (prove ? !r.fired : r.findings.length)) ? 1 : 0;
  }

  let bad = 0;
  for (const r of results) {
    if (prove) {
      const ok = r.fired;
      if (!ok) bad++;
      // A stale plant and a silent gate need different fixes, so the reason is named.
      const why = r.findings.find((f) => f.includes("no longer applies")) ?? "the planted case did not fire";
      console.log(`${ok ? "fires" : "SILENT"}  ${r.name}: ${ok ? r.findings[0] : why}`);
    } else {
      bad += r.findings.length;
      console.log(`${r.findings.length ? "FAIL" : "pass"}  ${r.name}: sees ${r.sees}`);
      console.log(`      blind to ${r.blind_to}`);
      for (const f of r.findings.slice(0, 8)) console.log(`      ${f}`);
    }
  }
  console.log(prove ? (bad ? "\na gate stayed silent on its own failing case" : "\nevery gate fired") : `\n${bad} finding(s). A clean run means nothing on its own: prove it with --prove.`);
  return bad ? 1 : 0;
}

process.exit(main());
