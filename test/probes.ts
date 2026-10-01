/**
 * Metamorphic probes: change an input in a way whose effect is known, and check the output moved the
 * way it had to.
 *
 * **Why this exists, and why it is a measurement rather than a gate.** A scored task needs real
 * packets and gold answers. A metamorphic relation
 * needs neither: it needs one artifact and a mutation whose polarity
 * is known in advance. That makes it a measurement available before any real packet is scored. The named form is CheckList's
 * invariance and directional tests (Ribeiro et al., 2020), and the reason it belongs in the harness
 * rather than in the answering path is measured elsewhere: every method that improved accuracy on
 * questions with a false premise degraded accuracy on questions with a true one, and about 13% of
 * real questions carry a false premise (published work on false-premise questions).
 * **A probe is an instrument, never a filter.**
 *
 * **THREE polarities, because two would hide the interesting one.**
 *
 * - `supported`: a mutation that preserves every value must leave the sentence supported.
 * - `refused`: a mutation that changes a value must be refused AND the refusal must name what
 *   changed. Without the second half the relation proves nothing, because some earlier check may
 *   have rejected the sentence for its own reason. `test/answer.test.ts` already carries one of
 *   those, found by the deletion pass: a date test that passes with the date check deleted.
 * - `unchecked`: a documented exemption, where the check is expected NOT to catch the mutation. This
 *   polarity fails when an exemption silently goes away, which is what turns a comment into an
 *   instrument. It is the only polarity here that reports a behaviour becoming stricter.
 *
 * What no probe in this file can see: whether a passage SUPPORTS the sentence whose receipt points at
 * it. That is invariant 3, it is a person's job by construction, and it is why a reader confirms it.
 */
import type { Passage } from "../src/answer/retrieve.js";
import { checkSentence } from "../src/answer/answer.js";

export type Polarity = "supported" | "refused" | "unchecked";

export type Mutation = {
  /** What kind of thing is being swapped, for the report's own columns. */
  kind: string;
  from: string;
  to: string;
  expect: Polarity;
  /** For `refused`: the refusal must name this. Defaults to the mutated text. */
  names?: string;
  /** For `unchecked`: why the exemption exists, so the report says it rather than implying it. */
  because?: string;
};

export type Case = { sentence: string; passage: Passage; mutations: Mutation[] };

export type Check = (text: string, cited: Passage[]) => { ok: true } | { ok: false; why: string };

export type Outcome = {
  case_: string;
  kind: string;
  expect: Polarity;
  got: "supported" | "refused";
  why: string;
  violation: string | null;
};

const passageOf = (text: string, id = "p1", page = 3): Passage => ({
  id,
  document_id: 1,
  filename: "packet.txt",
  page_no: page,
  text,
  meeting: null,
  kind: "passage",
});

/**
 * SYNTHETIC, written here on 2026-09-29. Not a real board's material, and no result on real
 * material rests on it.
 *
 * Two passages, because the name probes need a passage that carries names at all and the figure
 * probes need one that carries figures in a form the change record also normalises.
 */
export const FIGURES = passageOf(
  "Item 4.1 Resolution 2026-07 authorises the general manager to execute Contract PO-44821 for " +
    "substation rebuild work in an amount not to exceed $1,200,000. The work is scheduled to be " +
    "complete by October 15, 2026. Item 4.2 Tariff Advice No. 118 proposes a rate increase of 3.5 " +
    "percent effective July 1, 2026. Resolution 2026-07 was approved on a vote of 5-2.",
);

export const NAMES = passageOf(
  "Director Alvarez asked for a report on the substation rebuild. Director Petrov moved to accept " +
    "the consent agenda. Ito seconded the motion.",
  "p2",
  7,
);

/**
 * The cases, as data. Each mutation is one relation.
 *
 * The positions matter and are deliberate: `checkSentence` treats a capitalised word in FIRST
 * position differently from the same word mid-sentence, exempting it when it is a known sentence
 * opener, so a name probe that only ever appears mid-sentence would report a check stronger than the
 * one that exists.
 */
export const CASES: Case[] = [
  {
    sentence: "Resolution 2026-07 authorises Contract PO-44821 in an amount not to exceed $1,200,000.",
    passage: FIGURES,
    mutations: [
      {
        kind: "money, same value",
        from: "$1,200,000",
        to: "$1.2 million",
        expect: "supported",
      },
      { kind: "money, changed", from: "$1,200,000", to: "$1,400,000", expect: "refused", names: "1,400,000" },
      // A digit that appears INSIDE the real figure. The substring defect this replaced certified
      // "the amount is $20" against a passage saying $1,200,000, which is why values are a set of
      // tokens rather than a string to search inside.
      { kind: "money, a substring of the real one", from: "$1,200,000", to: "$20", expect: "refused", names: "20" },
    ],
  },
  {
    sentence: "The work is scheduled to be complete by October 15, 2026.",
    passage: FIGURES,
    mutations: [
      { kind: "date, same day written differently", from: "October 15, 2026", to: "15 October 2026", expect: "supported" },
      // These two are a PAIR and the first run is why. "October 16, 2026" is refused on the bare 16,
      // by the VALUE check, before the date check ever compares a date, so on its own it measures the
      // wrong thing. The harness said so in its first run: "refused, but for another reason". The
      // existing suite carries the same defect as a comment (test/answer.test.ts, the date test that
      // passes with the date check deleted); this makes it two instruments instead of a paragraph.
      { kind: "date, one day later (caught by the VALUE check)", from: "October 15, 2026", to: "October 16, 2026",
        expect: "refused", names: "16",
        because: "the bare 16 is absent, so this never reaches the date comparison" },
      // Every token here is in the passage: July, 15 and 2026 all appear, and July is on the COMMON
      // list. So the value and name checks cannot reject it and only the whole-date comparison can.
      { kind: "date, a day assembled from tokens the passage HAS", from: "October 15, 2026", to: "July 15, 2026",
        expect: "refused", names: "July 15, 2026",
        because: "the only check that can see this is the one that compares a whole date" },
    ],
  },
  {
    sentence: "Tariff Advice No. 118 proposes a rate increase of 3.5 percent.",
    passage: FIGURES,
    mutations: [
      { kind: "percent, same value", from: "3.5 percent", to: "3.5%", expect: "supported" },
      { kind: "percent, changed", from: "3.5 percent", to: "4.5 percent", expect: "refused", names: "4.5" },
    ],
  },
  {
    sentence: "Resolution 2026-07 was approved on a vote of 5-2.",
    passage: FIGURES,
    mutations: [
      { kind: "vote count, reversed", from: "5-2", to: "2-5", expect: "supported",
        // Both tokens are in the passage, so the value set cannot tell 5-2 from 2-5. This is the
        // sharpest limit in the receipt check and it is recorded as `supported` on purpose: the
        // check is about values being PRESENT, never about what they are attached to.
        because: "a receipt says the value is in the passage, not that the passage supports the sentence" },
      { kind: "vote count, invented", from: "5-2", to: "6-1", expect: "refused", names: "6" },
    ],
  },
  {
    sentence: "Director Alvarez asked for a report on the substation rebuild.",
    passage: NAMES,
    mutations: [
      { kind: "name, mid-sentence, absent", from: "Alvarez", to: "Kowalski", expect: "refused", names: "Kowalski" },
      { kind: "name, mid-sentence, present elsewhere", from: "Alvarez", to: "Petrov", expect: "supported" },
    ],
  },
  {
    sentence: "Alvarez asked for a report on the substation rebuild.",
    passage: NAMES,
    mutations: [
      { kind: "name, first position, absent", from: "Alvarez", to: "Kowalski", expect: "refused", names: "Kowalski" },
      {
        kind: "name, first position, a word on the COMMON list",
        from: "Alvarez",
        to: "Management",
        expect: "unchecked",
        because:
          "COMMON exempts words a model uses to talk ABOUT the evidence (Staff, Management, Board). " +
          "The cost is that a sentence attributing something to management is unchecked when the " +
          "passage never mentions management",
      },
      {
        kind: "name, two letters",
        from: "Alvarez",
        to: "Ng",
        expect: "unchecked",
        because:
          "NAMEISH is /[A-Z][a-z]{2,}/, so a two-letter name never matches it at all and the length " +
          "floor below is unreachable for one. The comment above that floor says lowering it from " +
          "four to three recovered Ito, Wu and Ng; it recovered Ito",
      },
    ],
  },
];

/** Every relation, against a checker. The checker is a parameter so `--prove` can pass a stub. */
export function receiptRelations(check: Check = checkSentence): Outcome[] {
  const out: Outcome[] = [];
  for (const c of CASES) {
    // The unmutated sentence must be supported, or every relation below it is measuring the base
    // sentence rather than the mutation.
    const base = check(c.sentence, [c.passage]);
    if (!base.ok) {
      out.push({
        case_: c.sentence,
        kind: "the base sentence itself",
        expect: "supported",
        got: "refused",
        why: base.why,
        violation: `the unmutated sentence was refused, so nothing under it measures a mutation: ${base.why}`,
      });
      continue;
    }
    for (const m of c.mutations) {
      if (!c.sentence.includes(m.from)) {
        out.push({
          case_: c.sentence, kind: m.kind, expect: m.expect, got: "supported", why: "",
          violation: `the mutation no longer applies: "${m.from}" is not in the sentence`,
        });
        continue;
      }
      const mutated = c.sentence.replace(m.from, m.to);
      const r = check(mutated, [c.passage]);
      const got = r.ok ? "supported" : "refused";
      const why = r.ok ? "" : r.why;
      let violation: string | null = null;
      if (m.expect === "supported" && got === "refused") {
        violation = `a value-preserving change was refused: ${why}`;
      } else if (m.expect === "refused" && got === "supported") {
        violation = `a changed value was accepted: "${m.to}" is not in the passage`;
      } else if (m.expect === "refused" && got === "refused") {
        const must = m.names ?? m.to;
        if (!why.includes(must)) {
          // Caught, and by something else. That is a relation that proves nothing about the check it
          // was aimed at, which is the shape of a regression test written against the fix.
          violation = `refused, but for another reason: the message names neither "${must}" nor the mutation (${why})`;
        }
      } else if (m.expect === "unchecked" && got === "refused") {
        violation = `a documented exemption has gone away, which may be an improvement: ${why}`;
      }
      out.push({ case_: c.sentence, kind: m.kind, expect: m.expect, got, why, violation });
    }
  }
  return out;
}

export const alwaysOk: Check = () => ({ ok: true });
export const alwaysRefuse: Check = () => ({ ok: false, why: "stub" });
