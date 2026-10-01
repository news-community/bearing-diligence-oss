/**
 * Item A: the PRE-INGESTION axis, as a family rather than as four hand-written cases.
 *
 * The other families mutate what comes out: a sentence a model wrote, or a question. This one mutates
 * the document BEFORE it is read, which is a different axis and not a substitute for the other. The
 * outside measurement is the reason it exists rather than a preference: applying the same mutation
 * operators upstream of the index and downstream of retrieval found overlapping but different faults,
 * with **only 12% to 45% overlap** (a 2026 mutation study). Four hand-written cases in `test/change.test.ts` cover an unknown fraction of
 * the mutation space, and nobody could say which.
 *
 * **The design that makes the oracle exact**: the same packet is ingested twice, the second copy
 * carrying exactly ONE mutation, so the change record's correct output is known precisely rather than
 * approximately. The control is the unmutated copy, which must produce no change at all; without it a
 * family that reports "the expected change appeared" cannot tell that from a record that reports
 * everything as changed.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmLocation, openRecord } from "../src/record/db.js";
import { addDocument } from "../src/record/store.js";
import { computeChangeRecord } from "../src/change/compare.js";
import { PACKET_A } from "./fixtures.js";

export type Expect = "reported" | "not reported" | "unchecked";

export type PreCase = {
  kind: string;
  from: string;
  to: string;
  expect: Expect;
  /** For `reported`: the change kind the record must use, and the subject it must name. */
  changeKind?: "new_identifier" | "moved_figure" | "moved_date" | "recurrence";
  subject?: string;
  because?: string;
};

/**
 * One mutation per case, applied to a copy of PACKET_A, and the change the record must then report.
 *
 * The three polarities are the same three the receipt family uses, and `unchecked` does the same job:
 * it names a capability the change record does not have, and it fails if that silently becomes a
 * capability, which turns a limit into an instrument instead of a comment.
 */
export const PRE_CASES: PreCase[] = [
  {
    kind: "money changed",
    from: "$1,200,000",
    to: "$1,400,000",
    expect: "reported",
    changeKind: "moved_figure",
  },
  {
    kind: "money in another format, same value",
    from: "$1,200,000",
    to: "$1.2 million",
    expect: "not reported",
    because: "the figure is normalised by value, so a reformat is not a change and saying it is would " +
      "put the reader in front of a diff of typography",
  },
  {
    kind: "percent changed",
    from: "3.5 percent",
    to: "4.5 percent",
    expect: "reported",
    changeKind: "moved_figure",
  },
  {
    kind: "date moved",
    from: "October 15, 2026",
    to: "December 3, 2026",
    expect: "reported",
    changeKind: "moved_date",
  },
  {
    kind: "date in another format, same day",
    from: "October 15, 2026",
    to: "15 October 2026",
    expect: "not reported",
    because: "the date is normalised to an ISO day",
  },
  {
    kind: "a new identifier appears",
    from: "Item 5 Docket U-26-014",
    to: "Item 5 Docket U-26-014 and Resolution 2026-33",
    expect: "reported",
    changeKind: "new_identifier",
    subject: "resolution:2026-33",
  },
  {
    kind: "an identifier is REMOVED",
    from: "Tariff Advice No. 118",
    to: "a tariff filing",
    expect: "unchecked",
    because:
      "the change record reports what is NEW and has no kind for what has gone. An item that quietly " +
      "leaves the packet is invisible to it, which is a real gap in the shape the product is for and " +
      "is recorded here rather than in prose",
  },
  // These two were written expecting "reported" and the first run falsified both. The
  // reclassification is recorded rather than quietly applied, because a violation turned into an
  // exemption is the one dishonesty this design has to keep out.
  //
  // `figures()` has a money branch and a percent branch and nothing else: measured by calling it on
  // "a vote of 5-2" (nothing), "Ayes: 5, Nays: 2" (nothing) and "replaced 1,180 poles" (nothing).
  // The `Figure` type declares `kind: "money" | "percent" | "count"` and **no code path ever produces
  // a count**, so the change record cannot see a vote that changed, a pole count that changed or a
  // megawatt figure that changed. Nothing promised it could, which is why these are exemptions and
  // not failures, and the declaration is left alone rather than edited away: whether to implement
  // counts or drop the word is a person's call, with a real false-positive cost either way.
  {
    kind: "a vote count changed (5-2 to 4-3)",
    from: "a vote of 5-2",
    to: "a vote of 4-3",
    expect: "unchecked",
    because: "no bare count is extracted, so a changed vote is invisible to the change record",
  },
  {
    kind: "a tallied vote changed (Ayes 5 Nays 2)",
    from: "Ayes: 5, Nays: 2",
    to: "Ayes: 4, Nays: 3",
    expect: "unchecked",
    because: "the same gap in its other written form, so the exemption is two instances rather than one",
  },
];

export type PreOutcome = {
  kind: string;
  expect: Expect;
  got: string;
  violation: string | null;
};

async function changesFor(second: string): Promise<{ kinds: string[]; subjects: string[]; n: number }> {
  const dir = mkdtempSync(join(tmpdir(), "probes-pre-"));
  try {
    confirmLocation(dir, "the probe harness");
    const rec = openRecord(dir);
    const a = join(dir, "march.txt");
    const b = join(dir, "april.txt");
    writeFileSync(a, PACKET_A);
    writeFileSync(b, second);
    await addDocument(rec, a, "public", "2026-03 regular", "2026-03-12");
    const added = await addDocument(rec, b, "public", "2026-04 regular", "2026-04-09");
    const cr = computeChangeRecord(rec.db, added.document_id);
    const out = {
      kinds: cr.changes.map((c) => c.kind),
      subjects: cr.changes.map((c) => c.subject),
      n: cr.changes.length,
    };
    rec.db.close();
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A sentence carrying no identifier, no figure and no date, added so the second copy is a DIFFERENT
 * document. The first version of this family used PACKET_A unchanged as its control and the control
 * fired: the raw store is keyed by content digest, so identical text does not become a second
 * document at all, and the change record was correctly comparing document one against nothing and
 * calling every identifier new. **The control was wrong and the code was right**, which is the safer
 * way round and is the second time today a probe's own oracle was the defect.
 */
const NEUTRAL = "\nMaterials were distributed to directors in advance of the meeting.\n";

/**
 * `neutral` is a parameter so `--prove` can hand it a suffix that DOES change a value and require the
 * baseline relation to come back negative. A control nobody has seen fail is not a control.
 */
export async function preIngestionRelations(neutral = NEUTRAL): Promise<PreOutcome[]> {
  const out: PreOutcome[] = [];
  const judged = ["new_identifier", "moved_figure", "moved_date"] as const;

  // The baseline: a copy that differs in text and in NO value. Everything below is judged on the
  // difference from this, so each relation measures its own mutation and nothing else.
  const base = await changesFor(PACKET_A + neutral);
  const baseJudged = base.kinds.filter((k) => (judged as readonly string[]).includes(k));
  out.push({
    kind: "baseline: a copy that changes no value",
    expect: "not reported",
    got: base.n === 0 ? "no change" : `${base.kinds.length} change(s): ${[...new Set(base.kinds)].join(", ")}`,
    violation: baseJudged.length === 0 ? null :
      `a copy that changes no value produced ${baseJudged.join(", ")}, so nothing below isolates a ` +
      "mutation",
  });
  // Recurrence is not noise and is not judged above: an item coming up again IS the finding, and
  // this asserts the baseline produces it, so a record that reported nothing at all would be caught.
  out.push({
    kind: "recurrence: items that came up before are named",
    expect: "reported",
    got: `${base.kinds.filter((k) => k === "recurrence").length} recurrence(s)`,
    violation: base.kinds.includes("recurrence") ? null :
      "a second packet carrying the same items reported no recurrence at all, so the baseline is not " +
      "a comparison",
  });
  if (baseJudged.length) return out;

  for (const c of PRE_CASES) {
    if (!PACKET_A.includes(c.from)) {
      out.push({ kind: c.kind, expect: c.expect, got: "",
        violation: `the mutation no longer applies: "${c.from}" is not in the packet` });
      continue;
    }
    const got = await changesFor(PACKET_A.replace(c.from, c.to) + neutral);
    const added = got.kinds
      .map((k, i) => ({ k, s: got.subjects[i]! }))
      .filter((x) => (judged as readonly string[]).includes(x.k));
    const desc = added.length ? added.map((x) => `${x.k}:${x.s}`).join(", ") : "no judged change";
    let violation: string | null = null;
    if (c.expect === "reported") {
      if (!added.some((x) => x.k === c.changeKind)) {
        violation = `expected a ${c.changeKind}, got ${desc}`;
      } else if (c.subject && !added.some((x) => x.s === c.subject)) {
        violation = `a ${c.changeKind} was reported but not for ${c.subject}: ${desc}`;
      }
    } else if (c.expect === "not reported" && added.length) {
      violation = `a change was reported for a mutation that changes no value: ${desc}`;
    } else if (c.expect === "unchecked" && added.length) {
      violation = `something the change record is documented as unable to see was reported: ${desc}. ` +
        "That may be an improvement, and it means this limit is no longer a limit";
    }
    out.push({ kind: c.kind, expect: c.expect, got: desc, violation });
  }
  return out;
}
