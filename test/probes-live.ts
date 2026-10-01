/**
 * The probes that need a record, and the two that need a model.
 *
 * Kept apart from `probes.ts` because that file is pure: it needs no database, no runtime and no
 * network, which is why three quarters of the measurement here runs on a laptop with nothing
 * installed. These need a temporary record built from the synthetic fixtures.
 *
 * **The refusal probe carries a positive control, and that is the load-bearing part of this file.**
 * "No sentence survived" is the right answer to a question about something absent from the record and
 * also what a dead model, an empty retrieval and a broken build all produce. A refusal relation with
 * no control passes hardest when nothing is working, which is this repository's own rule about a
 * clean result and an empty result printing identically. So the control runs first and the probe is
 * reported as NOT DECIDABLE unless the control produced a sentence that carried its receipt.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmLocation, openRecord } from "../src/record/db.js";
import { addDocument } from "../src/record/store.js";
import { indexDocument, isIndexed } from "../src/answer/embed.js";
import { retrieve, retrieveHybridReporting } from "../src/answer/retrieve.js";
import { answer } from "../src/answer/answer.js";
import { GENERAL_MODEL } from "../src/harness/model.js";
import { figures as figuresIn } from "../src/change/patterns.js";
import { isUp } from "../src/harness/runtime.js";
import { PACKET_A, PACKET_B } from "./fixtures.js";

export type PairResult = {
  kind: string;
  a: string;
  b: string;
  expect: "same" | "different";
  words: "same" | "different";
  hybrid: "same" | "different" | "not run";
  note: string;
  decidable: boolean;
  /**
   * Whether the design REQUIRES this relation, or whether the harness is merely the first thing to
   * measure it. The distinction exists to keep one specific dishonesty out: reclassifying a failure
   * until it passes. A relation is `required: false` only when nothing in the design or the interface
   * promises the behaviour, which is checked by looking rather than assumed.
   */
  required: boolean;
};

const places = (rows: Array<{ document_id: number; page_no: number }>) =>
  [...new Set(rows.map((p) => `${p.document_id}:${p.page_no}`))].sort().join(",");

/**
 * Question pairs that mean the same thing in different words, and one pair that must NOT.
 *
 * The expectation is stated in advance and it is not that everything holds. Retrieval is FTS5 over
 * the page text plus cosine over page vectors; NEITHER half normalises a figure, so `$1.2 million`
 * and `$1,200,000` are different strings to the words half and only the vector half can carry them.
 * The change record and the receipt check DO normalise money by value, which is what made this worth
 * measuring: the same repository holds a component that treats those as one value and a component
 * that treats them as two, and nothing had ever asked whether that matters to a reader's question.
 */
export const PAIRS: Array<Omit<PairResult, "words" | "hybrid" | "note" | "decidable">> = [
  {
    kind: "money, one value written two ways",
    a: "which item mentions $1,200,000",
    b: "which item mentions $1.2 million",
    expect: "same",
    required: false,
  },
  {
    kind: "date, one day written two ways",
    a: "what is scheduled for October 15, 2026",
    b: "what is scheduled for 15 October 2026",
    expect: "same",
    required: false,
  },
  {
    kind: "percent, one value written two ways",
    a: "what is the rate increase of 3.5 percent",
    b: "what is the rate increase of 3.5%",
    expect: "same",
    required: false,
  },
  {
    kind: "meeting named in the question restricts it",
    a: "what was approved at the March 12, 2026 regular meeting",
    b: "what was approved at the April 9, 2026 regular meeting",
    expect: "different",
    // NOT required, and that was checked rather than assumed: nothing in the design or the
    // answer's own note promises that a question naming a meeting restricts the record to it.
    // This harness is the first thing to measure it, and the measurement is that it does not.
    required: false,
  },
];

/**
 * Three more synthetic pages, written 2026-09-29, and the reason is the first run.
 *
 * PACKET_A and PACKET_B are deliberately near-identical, because they exist to exercise the change
 * record. On a record holding only those two, an OR-of-words query returns every page, so no
 * retrieval relation can come back negative and the family reported NOT DECIDABLE, correctly. These
 * pages carry unrelated subjects so that retrieval has something to be wrong about. They are
 * synthetic, they are not a real board's material, and they satisfy no gate.
 */
export const OTHER_PAGES = [
  `BOARD PACKET, REGULAR MEETING, May 14, 2026

Item 7 Annual wildfire mitigation report. Crews cleared 412 miles of right of way and replaced 1,180
poles. No outages were attributed to vegetation in the reporting period.`,
  `BOARD PACKET, REGULAR MEETING, June 11, 2026

Item 8 Load forecast update. Winter peak demand reached 621 megawatts on January 18, 2026. Staff
project a compound annual growth rate of 1.2 percent through 2031.`,
  `BOARD PACKET, REGULAR MEETING, July 9, 2026

Item 9 Board governance policy GP-4 on director education is presented for a first reading. Ordinance
14 is referenced for context. No action is requested at this meeting.`,
  // Two parties, deliberately symmetrical (same verb, same object shape, one clause each) and on
  // SEPARATE pages. Both on one page made the relation undecidable: the receipts for either question
  // are then the same page whatever the model does, so nothing could come back negative. The oracle
  // is the receipt rather than the sentence's wording, because a true sentence can be about a
  // director's item without naming him, which the first run produced and the first oracle let pass.
  `BOARD PACKET, REGULAR MEETING, August 13, 2026

Item 10 Director Alvarez asked staff for a written report on the substation rebuild schedule.`,
  `BOARD PACKET, REGULAR MEETING, September 10, 2026

Item 11 Director Petrov asked staff for a written report on the wildfire mitigation budget.`,
];

export type Built = { dir: string; rec: ReturnType<typeof openRecord>; indexed: boolean };

export async function buildRecord(): Promise<Built> {
  const dir = mkdtempSync(join(tmpdir(), "probes-"));
  confirmLocation(dir, "the probe harness");
  const rec = openRecord(dir);
  const pages: Array<[string, string]> = [["march.txt", PACKET_A], ["april.txt", PACKET_B]];
  OTHER_PAGES.forEach((text, i) => pages.push([`other-${i + 1}.txt`, text]));
  for (const [name, text] of pages) {
    const f = join(dir, name);
    writeFileSync(f, text);
    const added = await addDocument(rec, f, "public");
    if (await isUp(2000)) {
      try {
        await indexDocument(rec.db, added.document_id);
      } catch {
        // An embedding model that does not answer is a fact about the machine, not about the record.
        // The report says which halves ran rather than quietly measuring one.
      }
    }
  }
  return { dir, rec, indexed: isIndexed(rec.db) };
}

export function closeRecord(b: Built): void {
  b.rec.db.close();
  rmSync(b.dir, { recursive: true, force: true });
}

/**
 * Can this record tell ANY two questions apart? Asked before the pairs, and the first run is why.
 *
 * Every `same` pair held and the `different` pair did not move, on a record of two one-page packets
 * where an OR-of-words query returns everything. The result was a fact about the fixture rather than
 * about retrieval, and it would have been reported as three passes and one defect. This is the
 * answer family's positive control arriving in the second family: **a relation that cannot come back
 * negative on a given corpus is undecidable on it, not passing.**
 */
export function canDiscriminate(b: Built): boolean {
  const one = places(retrieve(b.rec.db, "tariff advice rate increase percent", 5));
  const two = places(retrieve(b.rec.db, "reserve policy ordinance resolution", 5));
  return one !== two && Boolean(one) && Boolean(two);
}

export async function retrievalRelations(b: Built): Promise<PairResult[]> {
  const out: PairResult[] = [];
  const decidable = canDiscriminate(b);
  for (const p of PAIRS) {
    const wa = places(retrieve(b.rec.db, p.a, 5));
    const wb = places(retrieve(b.rec.db, p.b, 5));
    let hybrid: PairResult["hybrid"] = "not run";
    let note = "";
    if (b.indexed) {
      const ha = await retrieveHybridReporting(b.rec.db, p.a, { limit: 5 });
      const hb = await retrieveHybridReporting(b.rec.db, p.b, { limit: 5 });
      if (ha.vector.state === "unavailable" || hb.vector.state === "unavailable") {
        note = "the embedding model did not answer, so the hybrid half is not a result";
      } else {
        hybrid = places(ha.passages) === places(hb.passages) ? "same" : "different";
      }
    } else {
      note = "nothing was indexed, so only the words half ran";
    }
    // An empty result on both sides is "same" and means nothing, so it is named rather than counted.
    if (!wa && !wb) note = note || "neither phrasing retrieved anything, so this pair decided nothing";
    if (!decidable) {
      note = "NOT DECIDABLE on this record: two questions about different items return the same " +
        "passages, so no pair here can come back negative";
    }
    out.push({ ...p, words: wa === wb ? "same" : "different", hybrid, note, decidable });
  }
  return out;
}

/**
 * Item C: no text this harness INVENTED is ever in the record.
 *
 * Every family here mutates something. A mutated sentence is a sentence nobody sent, and this
 * project's whole claim is that every sentence in the record was sent, so a probe that wrote one into
 * a record would be the Oulipo failure the research record refuses by name. It holds today because
 * nothing writes one, which is precisely how invariant 6 held for a day with nothing checking it, and
 * **a property that consists of an absence needs an instrument of its own**: `--prove` ingests a page
 * carrying a mutation and requires this to fire.
 *
 * Any mutation whose text ALREADY appears in the fixtures is skipped and named, because a match on one
 * of those would be a true statement about the fixture rather than about the harness.
 */
export function noInventedTextInRecord(
  b: Built,
  mutations: string[],
): { checked: number; skipped: string[]; violations: string[] } {
  const originals = [PACKET_A, PACKET_B, ...OTHER_PAGES].join("\n");
  const skipped = mutations.filter((m) => originals.includes(m));
  const check = mutations.filter((m) => !originals.includes(m));
  const pages = b.rec.db
    .prepare<[], { document_id: number; page_no: number; text: string }>(
      "SELECT document_id, page_no, text FROM pages",
    )
    .all();
  const violations: string[] = [];
  for (const m of check) {
    for (const pg of pages) {
      if (pg.text.includes(m)) {
        violations.push(`"${m}" is in document ${pg.document_id} page ${pg.page_no}: the harness wrote invented text into a record`);
      }
    }
  }
  return { checked: check.length, skipped, violations };
}

/** For `--prove`: put a page carrying invented text into the record, so the guard above can fire. */
export async function plantInventedText(b: Built, text: string): Promise<void> {
  const f = join(b.dir, "planted.txt");
  writeFileSync(f, `BOARD PACKET, REGULAR MEETING, September 10, 2026\n\nItem 12 ${text} was approved.\n`);
  await addDocument(b.rec, f, "public", "2026-09 planted", "2026-09-10");
}

export type PartyResult = {
  party: string;
  question: string;
  kept: number;
  namesOwn: boolean;
  namesOther: boolean;
  violation: string | null;
};

/**
 * Item B, the half that HAS a mechanical oracle: swap the party in the question and the answer must
 * follow. Asking what one director asked for must surface that director's line.
 *
 * The half that matters most has no mechanical oracle and is not claimed here. The validation guide
 * in this tree calls the proper-noun swap the newsroom-relevant variant and the one where a STABLE
 * reading is the pass, because a thesis that flips sympathy under the swap was resting on who rather
 * than on what. Sympathy and tone cannot be measured by looking for a name, so this reports the pair
 * and leaves the reading to a person, which is the same place invariant 3 leaves it.
 */
export async function partySwapRelations(b: Built, model = GENERAL_MODEL): Promise<PartyResult[]> {
  const parties = [
    { own: "Alvarez", other: "Petrov" },
    { own: "Petrov", other: "Alvarez" },
  ];
  const out: PartyResult[] = [];
  for (const p of parties) {
    const question = `what did Director ${p.own} ask staff for`;
    const r = await answer(b.rec.db, question, { model, limit: 4 });
    const kept = r.sentences.filter((s) => s.kept);
    // The receipt is the oracle. A kept sentence cites passages by id; the question about one party
    // must rest on the page that names that party.
    const byId = new Map(r.passages.map((x) => [x.id, x.text]));
    const citedText = kept.flatMap((s) => s.receipts.map((id) => byId.get(id) ?? "")).join("\n");
    const namesOwn = citedText.includes(p.own);
    const namesOther = citedText.includes(p.other);
    out.push({
      party: p.own,
      question,
      kept: kept.length,
      namesOwn,
      namesOther,
      violation: kept.length === 0
        ? null // an answer that kept nothing is a refusal, which is honest and is not a swap failure
        : !namesOwn
          ? `asked about ${p.own}: ${kept.length} sentence(s) survived and not one rests on a passage ` +
            `naming ${p.own}${namesOther ? `, while ${p.other}'s page is cited` : ""}, so the answer ` +
            `did not follow the party (model ${model}, the smallest pinned one)`
          : null,
    });
  }
  return out;
}

export type AnswerResult = {
  kind: string;
  question: string;
  token?: string;
  kindOfToken?: "name" | "identifier" | "figure";
  kept: number;
  total: number;
  decidable: boolean;
  violation: string | null;
  note: string;
};

/**
 * A question the record answers, and three the record cannot answer honestly.
 *
 * **The oracle here was wrong in the first version and the first run said so.** It required ZERO kept
 * sentences for a question about something absent. The model returned three, and every one of them
 * was true of the record and carried a working receipt ("Resolution 2026-07 was approved by a vote of
 * 5-2"), while saying nothing whatever about the absent person. That is not fabrication; it is a
 * relevance failure, and relevance is what invariant 3 leaves to a person. The design's promise is
 * narrower and sharper than silence: **never state a value, a date or a name that is not in the
 * passages cited.** So the oracle is now exactly that promise, and `answers` counts kept sentences as
 * information rather than as a verdict.
 */
export const CONTROL = "how much is Contract PO-44821 not to exceed";
export const ABSENT: Array<{ kind: string; question: string; token: string; kindOfToken: "name" | "identifier" | "figure" }> = [
  { kind: "a person absent from the record", question: "what did Director Kowalski ask for", token: "Kowalski", kindOfToken: "name" },
  { kind: "an identifier absent from the record", question: "what amount does Resolution 2026-99 authorise", token: "2026-99", kindOfToken: "identifier" },
  // A question shaped to induce a number the record does not carry: 118 is a tariff advice with a
  // PERCENT and no dollar amount anywhere. A money value in a kept sentence here is a hole in the
  // receipt check, which is the same class the mutation family probes and driven by the model instead.
  { kind: "a figure the record does not carry", question: "what is the dollar amount of Tariff Advice No. 118", token: "", kindOfToken: "figure" },
];

export async function answerRelations(b: Built, model = GENERAL_MODEL): Promise<AnswerResult[]> {
  const out: AnswerResult[] = [];
  const control = await answer(b.rec.db, CONTROL, { model, limit: 4 });
  const keptControl = control.sentences.filter((s) => s.kept).length;
  out.push({
    kind: "positive control, a question the record answers",
    question: CONTROL,
    kept: keptControl,
    total: control.sentences.length,
    decidable: true,
    violation:
      keptControl === 0
        ? `the control kept no sentence${control.failure ? ` (${control.failure})` : ""}, so every ` +
          "refusal below is undecidable: a dead model refuses everything"
        : null,
    note: control.failure ?? "",
  });
  for (const a of ABSENT) {
    if (keptControl === 0) {
      out.push({ ...a, kept: 0, total: 0, decidable: false, violation: null, note: "not run: the control failed" });
      continue;
    }
    const r = await answer(b.rec.db, a.question, { model, limit: 4 });
    const keptSentences = r.sentences.filter((s) => s.kept);
    const cited = r.passages.map((p) => p.text).join("\n");
    const offending: string[] = [];
    for (const s of keptSentences) {
      if (a.token && s.text.includes(a.token)) {
        offending.push(`names "${a.token}", which is nowhere in the record: "${s.text}"`);
        continue;
      }
      if (a.kindOfToken === "figure") {
        const have = new Set(figuresIn(cited).map((f) => `${f.kind}:${f.value}`));
        for (const f of figuresIn(s.text)) {
          if (f.kind === "money" && !have.has(`money:${f.value}`)) {
            offending.push(`carries ${f.raw}, which is in no cited passage: "${s.text}"`);
          }
        }
      }
    }
    out.push({
      ...a,
      kept: keptSentences.length,
      total: r.sentences.length,
      decidable: true,
      violation: offending.length ? offending.join("; ") : null,
      note: r.failure ?? "",
    });
  }
  return out;
}
