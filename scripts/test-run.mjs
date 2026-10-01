/**
 * The tests, plus the thing `node --test` will not tell you: what did not run.
 *
 * Eight tests here skip themselves when the model runtime is down or tesseract is not installed,
 * which is right: a test that cannot reach its subject should not fail as though the subject were
 * broken. But `node --test` exits 0 on a run that skipped them, and `npm run check` then prints
 * success on a machine where a sixth of the suite never executed. A clean result and an empty
 * result print identically and mean opposite things.
 *
 * So this runs the suite, names every test that did not run and why, and FAILS unless the skips are
 * acknowledged deliberately:
 *
 *   npm test                     fails if anything skipped, naming it
 *   SKIPS_OK=1 npm test          runs anyway, still naming every skip
 */
import { spawn } from "node:child_process";
import { exit } from "node:process";

// The glob is an argument so this can be pointed at one file, which is how the skip detector below
// gets shown able to fire: run the OCR tests with tesseract off PATH and it must name all four.
const glob = process.argv[2] ?? "dist/test/**/*.test.js";
// process.execPath, not "node": everything here runs under Electron's own Node, so there is one
// native build of better-sqlite3 rather than two fighting over one folder. Spawning whatever `node`
// is on PATH would load the module under a different ABI and fail before a test ran.
//
// The reporter is named rather than defaulted. The skip detector below parses TAP, and Node 24 made
// "spec" the default whatever stdout is: moving to Electron 44 silently changed the format, and the
// detector would have found no skips on a run that skipped nine.
const child = spawn(process.execPath, ["--test", "--test-reporter=tap", glob], {
  stdio: ["inherit", "pipe", "inherit"],
  shell: false,
});

let out = "";
child.stdout.on("data", (b) => {
  const s = String(b);
  out += s;
  process.stdout.write(s);
});

child.on("close", (code) => {
  // node:test prints a skipped test as "ok N - name # SKIP <reason>", and the reason is the whole
  // value of this: "runtime down" and "tesseract is not installed" are different machines.
  const skipped = [...out.matchAll(/^ok \d+ - (.+?) # (?:SKIP|skip)(?:\s+(.*))?$/gm)]
    .map((m) => ({ name: m[1].trim(), reason: (m[2] ?? "").trim() || "no reason given" }));

  if (!skipped.length) {
    if (code === 0) console.log("\nnothing skipped: every test reached its subject.");
    exit(code ?? 1);
  }

  console.log(`\n${skipped.length} test(s) DID NOT RUN. The suite is green about ${skipped.length} fewer things than it looks:`);
  for (const s of skipped) console.log(`  ${s.name}\n      ${s.reason}`);

  if (process.env.SKIPS_OK === "1") {
    console.log("\nSKIPS_OK=1, so this is not being treated as a failure. It is still true.");
    exit(code ?? 1);
  }
  console.log("\nFix the precondition each one names, or run with SKIPS_OK=1 to say you meant it.");
  exit(code === 0 ? 1 : code ?? 1);
});
