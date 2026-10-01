/**
 * An answer, with a receipt on every sentence, and the sentences that failed shown as dropped.
 *
 * The shape is: retrieve by code, ONE call, then a check by code. The model never searches, never
 * calls a tool, and never decides what evidence it gets. What it does is write prose over passages
 * it was handed, and every sentence it writes is then held against them:
 *
 *   no receipt                     dropped
 *   a number its passages lack     dropped
 *   a date its passages lack       dropped
 *   a name its passages lack       dropped
 *
 * Code cannot say whether a passage SUPPORTS a sentence. Only a reader can, which is why the
 * passage sits beside every sentence they read and why a reader confirms it (invariant 3).
 */
import type Database from "better-sqlite3";
import { ask } from "../harness/model.js";
import type { Asker } from "../harness/choose.js";
import { documentLabel } from "../ui/doc-label.js";
import { narrow, Passage, retrieveHybridReporting, type VectorHalf, retrieve } from "./retrieve.js";
import { dates as datesIn, figures as figuresIn } from "../change/patterns.js";

export type Sentence = {
  text: string;
  receipts: string[];
  kept: boolean;
  dropped_because?: string;
};
export type Answer = {
  question: string;
  sentences: Sentence[];
  passages: Passage[];
  model: string;
  /** Where the answer was written: on this computer, or through the hosted path the folder chose. */
  via: "local" | "cloud";
  /** The company a hosted router sent this call to, as it reported; absent for a local answer. */
  served_by?: string;
  failure?: string;
  note: string;
  /** What the vector half of retrieval did, so "found nothing" and "never ran" are never the same. */
  retrieval: VectorHalf;
};

const SCHEMA = {
  type: "object",
  properties: {
    sentences: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          receipts: { type: "array", items: { type: "string" } },
        },
        required: ["text", "receipts"],
        additionalProperties: false,
      },
    },
  },
  required: ["sentences"],
  // A hosted model asked for a strict schema refuses one that leaves extra fields open.
  additionalProperties: false,
};

/**
 * How many passages an answer is given. Eight could not cover a question across six meetings; the
 * strongest model measured then said honestly that only one labor agreement existed, because the
 * other was never offered (2026-09-30). CALIBRATE on larger folders.
 */
export const ANSWER_PASSAGES = 16;

/** The longest answer a model may write. */
export const ANSWER_MAX_TOKENS = 2048;

const SYSTEM =
  "You answer only from the passages given. Write short sentences. Every sentence must list the " +
  "ids of the passages it rests on. Never state a number, a date or a name that is not in the " +
  "passages you cite. If the passages do not answer the question, say so in one sentence citing " +
  "the closest passage. Never recommend what to do. An agenda lists what a board is asked to do: " +
  "say an item was approved, adopted or passed only if a passage says it was.";

/** Words that open an English sentence as grammar. Anything else in first position may be a name. */
const OPENERS = new Set([
  "The", "This", "That", "These", "Those", "There", "They", "Their", "It", "Its", "He", "She",
  "His", "Her", "We", "Our", "You", "Your", "His", "Both", "Each", "Every", "Neither", "Either",
  "Some", "Most", "Many", "Several", "One", "Two", "Three", "Four", "Five", "Six", "Seven",
  "Eight", "Nine", "Ten", "After", "Before", "During", "Because", "Although", "While", "When",
  "Where", "Which", "What", "Who", "Whose", "How", "Why", "If", "In", "On", "At", "By", "For",
  "From", "With", "Without", "Under", "Over", "According", "As", "Also", "And", "But", "Nothing",
  "No", "Not", "None", "Only", "Staff", "Management", "Directors", "Members",
]);

// A number is a standalone token, not a digit inside a word: the identifier "p1" in "Passage p1
// states..." is not the value 1, and reading it as one dropped true sentences.
const BARE_NUMBER = /(?<![A-Za-z0-9.])\d[\d,]*(?:\.\d+)?(?![A-Za-z])/g;

/**
 * Every value a text asserts, as a SET of tokens rather than as a string to search inside.
 *
 * Substring containment was the defect: the passages were concatenated, `,$%` stripped, and a
 * sentence's number looked for anywhere in the result. `$1,200,000` became `1200000`, which
 * contains `20`, `12` and `000`, so "the amount is $20" was certified by a passage saying
 * $1,200,000. Single digits were skipped outright, so a fabricated "vote of 4 to 1" passed against
 * a real 5 to 0. Both were found by holding the receipt check against sentences nobody had tried.
 *
 * Money and percentages are compared by VALUE, so $1.2 million and $1,200,000 are one value, which
 * is the same normalisation the change record uses. Everything else is compared as a whole token.
 */
function valuesIn(text: string): Set<string> {
  const out = new Set<string>();
  const spans: Array<[number, number]> = [];
  for (const f of figuresIn(text)) {
    out.add(`${f.kind}:${f.value}`);
    spans.push([f.start, f.end]);
  }
  for (const m of text.matchAll(BARE_NUMBER)) {
    const at = m.index ?? 0;
    if (spans.some(([a, b]) => at >= a && at < b)) continue;
    out.add(`n:${m[0].replace(/,/g, "").replace(/\.0+$/, "")}`);
  }
  return out;
}
const NAMEISH = /\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*\b/g;
/**
 * Words that open a sentence as discourse, not as a name, found in answers from six models on real
 * agendas (2026-09-30): each was refused as "the name Later", "the name Upcoming" and so on.
 */
const DISCOURSE = new Set([
  "Later", "Earlier", "Upcoming", "Listed", "Examples", "Example", "Other", "Additional", "Additionally",
  "Further", "Furthermore", "Finally", "First", "Second", "Third", "Next", "Then", "Here", "Separately",
  "Similarly", "Currently", "Previously", "Per", "Upon", "Specifically", "Separate", "Scheduled",
  "Items", "Regular", "Special", "Public", "Consent", "Presentations", "Reports", "Topics", "Another",
  "Various",
]);
const COMMON = new Set([
  "The", "This", "That", "These", "Those", "It", "They", "There", "Board", "Item", "Resolution",
  "Ordinance", "Docket", "Contract", "Tariff", "Agenda", "Minutes", "Meeting", "Committee",
  "January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
  "November", "December", "No", "Yes", "None", "Staff", "Motion", "Ayes", "Nays",
  // Words the model uses to talk ABOUT the evidence rather than about the organisation. Driving
  // the interface found the first of these: a true sentence was dropped because it began
  // "Passage p1 states...", and "Passage" was read as somebody's name.
  "Passage", "Passages", "Page", "Pages", "Document", "Packet", "Section", "Article", "Exhibit",
  "Attachment", "Appendix", "Report", "Records", "Record", "According", "Both", "Neither", "Each",
]);

/** The check that makes a receipt mean something: every value in the sentence is in its own sources. */
/** Words that state what a body decided. Each must appear, as that word, on the cited page. */
// A past-tense change verb is an outcome too: the agenda says "to increase", "to extend", and the
// 4B model wrote "increased" and "was extended" for every phrasing of the question tried (2026-09-30).
/** What makes an outcome word a statement about the evidence rather than about what happened. */
const HEDGED = /\b(?:whether|(?:do|does|did)\s+not\s+(?:say|state|show|indicate|record|mention|report|confirm)|(?:don't|doesn't|didn't)\s+(?:say|state|show|indicate|record|mention|report|confirm)|(?:no|not)\s+(?:record|indication|mention)\s+(?:of|that))\b/i;
const OUTCOME = /\b(approved|adopted|passed|ratified|rejected|denied|awarded|authorized|authorised|increased|decreased|extended|reduced|raised|lowered|amended)\b/gi;

export function checkSentence(text: string, cited: Passage[]): { ok: true } | { ok: false; why: string } {
  if (!cited.length) return { ok: false, why: "no receipt: the sentence cited no passage" };
  const haystack = cited.map((p) => p.text).join("\n");
  // Names are compared across line breaks: a PDF wraps "Customer Services" and "Committee" onto two
  // lines as readily as anything, and the name is the same name.
  const flat = haystack.replace(/\s+/g, " ");

  // The dates each cited document carries in its label (see the date check below), which a sentence
  // may give as the meeting's date; their day and year are values the sentence may carry too.
  const labelDates = cited.map((p) => documentLabel(p.filename).date).filter((d): d is string => Boolean(d)).join("\n");
  const have = valuesIn(haystack + "\n" + labelDates);
  for (const v of valuesIn(text)) {
    if (have.has(v)) continue;
    const shown = v.startsWith("money:") ? `$${Number(v.slice(6)).toLocaleString("en-US")}`
      : v.startsWith("percent:") ? `${v.slice(8)}%`
      : v.slice(2);
    return { ok: false, why: `the value ${shown} is not in the passages this sentence cites` };
  }
  // A date has to be checked AS A DATE. "December 3, 2026" against a passage holding
  // "October 15, 2026" and "Resolution 2026-07" passes a parts check: 3 is too short to test and
  // 2026 is present. The whole date is the value, so the whole date is what must be there.
  // The date each cited document carries in its label counts as that passage's date: the model is
  // shown "March 19, 2026 · Agenda, page 2" above the passage, and the reader sees the same label on
  // the citation, so a sentence giving the meeting's date is checkable against what both were shown.
  // Six real agendas refused "the March 19, 2026 agenda" because the date is on page 1 and the
  // passage was page 2 (2026-09-30).
  const haveDates = new Set([
    ...datesIn(haystack).map((d) => d.iso),
    ...datesIn(labelDates).map((x) => x.iso),
  ]);
  for (const d of datesIn(text)) {
    if (!haveDates.has(d.iso)) {
      return { ok: false, why: `the date ${d.raw} is not in the passages this sentence cites` };
    }
  }

  // An outcome is a claim of its own. An agenda says "Approve the negotiation..." and "Item 5 was
  // reviewed by the committee"; a sentence saying it WAS approved passed every check above, because
  // the numbers and names are on the page, and six real agendas produced it in every answer about a
  // contract (2026-09-30). So a sentence stating an outcome must find that same word on its page.
  for (const m of text.matchAll(OUTCOME)) {
    const word = m[0].toLowerCase();
    // A sentence that says the passages DO NOT establish the outcome is the caution this check exists
    // to encourage, not a claim: "The passages do not say whether the Board approved the MOU." Every
    // one of a strong model's "approved" refusals on real agendas was that sentence (2026-09-30).
    // "The MOU was not approved" still asserts an outcome, so plain negation does not qualify.
    if (HEDGED.test(text.slice(0, m.index))) continue;
    if (!new RegExp(`\\b${word}\\b`, "i").test(haystack)) {
      return { ok: false, why: `it says "${word}", and the passages it cites do not; an agenda lists what is proposed` };
    }
  }

  // A capitalised word that opens a sentence is usually grammar rather than a name, so the check
  // starts after it. The cost is that a name in first position is unchecked, which is why this is
  // the weakest of the three checks and why the passage is shown regardless.
  for (const m of [...text.matchAll(NAMEISH)]) {
    // A grammar word in front of a name is not part of it: "The Finance and Audit Committee" is
    // checked as "Finance", and "Those Regular Meetings" as "Regular Meetings". Checking the whole
    // match looked for "The Finance" on a page that says "the Finance" and refused a true sentence
    // from every fluent model measured (2026-09-30).
    const parts = m[0].split(/\s+/);
    while (parts.length > 1 && (OPENERS.has(parts[0]!) || COMMON.has(parts[0]!) || DISCOURSE.has(parts[0]!))) parts.shift();
    const word = parts.join(" ");
    // At position 0, exempt only words that are KNOWN sentence openers rather than every single
    // word. The first version exempted any lone capitalised word there, so "Petrov asked for a
    // report" was unchecked: a closed list of grammar is a much smaller hole than an open one.
    const loneOpener = m.index === 0 && !/\s/.test(m[0]);
    if (loneOpener && !OPENERS.has(word) && !COMMON.has(word) && !DISCOURSE.has(word)) {
      // In first position every word is capitalised, so the page may hold it in lower case
      // ("Technology reimbursement" against "technology reimbursement"). An invented name is on the
      // page in no case at all, which is what this still refuses.
      // A gerund opening a sentence restates an agenda's verb: "Authorizing the Chief Executive
      // Officer..." for "Authorize the Chief Executive Officer...", refused as a name on every
      // consent-calendar answer (gemma3:27b, 2026-09-30). Its stem on the page is the evidence.
      const gerundStem = /^[A-Z][a-z]{3,}ing$/.test(word) ? word.slice(0, -3) : null;
      const onPage = new RegExp(`\\b${word}\\b`, "i").test(flat) || (gerundStem !== null && new RegExp(`\\b${gerundStem}`, "i").test(flat));
      if (!onPage) {
        return { ok: false, why: `the name ${word} is not in the passages this sentence cites` };
      }
      continue;
    }
    // Three characters, not four: the four-character floor skipped short names everywhere but first
    // position. This comment used to claim the change recovered "Ito, Wu and Ng"; it recovered Ito.
    // NAMEISH is /[A-Z][a-z]{2,}/, so a two-letter name never matches the pattern at all and this
    // floor is unreachable for one. Measured by `npm run probes`, where it is a documented exemption
    // rather than a comment, and it fails if the exemption ever silently goes away.
    if (loneOpener || COMMON.has(word) || word.length < 3) continue;
    if (word.split(/\s+/).every((w) => COMMON.has(w))) continue;
    if (!flat.includes(word)) {
      return { ok: false, why: `the name ${word} is not in the passages this sentence cites` };
    }
  }
  return { ok: true };
}

/**
 * Models write their citation into the prose as well as into the receipts field, so a sentence
 * arrives as "... Contract PO-44821 {p1}". The receipt is shown under the sentence already, and the
 * marker in the text is noise. Only a marker made ENTIRELY of passage ids is removed: anything else
 * is the model's own words and stays, including a bracket it meant.
 */
const CITATION_MARKER = /\s*[[{(]\s*(?:p\d+)(?:\s*[,;]\s*p\d+)*\s*[\]})]\s*/g;

export function stripCitationMarkers(text: string): string {
  // An emptied bracket, "( )", is what a model leaves when it half-writes a marker.
  // A bare id left at the end of a sentence ("...$29.67 million p10.") is a marker without its brackets.
  return text.replace(CITATION_MARKER, " ").replace(/\s*[[({]\s*[\])}]/g, " ").replace(/\s+p\d+(?=\s*[.,;:]?\s*(?:$|\n))/g, "")
    .replace(/\s+([.,;:])/g, "$1").replace(/\s+/g, " ").trim();
}

/**
 * Splitting prose into sentences without shattering it at an abbreviation.
 *
 * "The board met with Dr. Smith on Monday." became two answer sentences, "The board met with Dr."
 * and "Smith on Monday.", each shown separately and each checked on its own. The mangling
 * looked like the model's fault and was this function's.
 */
const ABBREV_TAIL = /\b(?:Res|No|Nos|Mr|Mrs|Ms|Dr|Prof|Sec|Art|Inc|Ltd|Co|Corp|St|Ave|Rd|Dept|Fig|Vol|Jr|Sr|U\.S|[A-Z])\.$/;

function splitSentences(s: string): string[] {
  const out: string[] = [];
  let at = 0;
  for (const m of s.matchAll(/(?<=[.!?])\s+(?=[A-Z])/g)) {
    const cut = m.index ?? 0;
    if (ABBREV_TAIL.test(s.slice(at, cut))) continue;
    const piece = s.slice(at, cut).trim();
    if (piece) out.push(piece);
    at = cut + m[0].length;
  }
  const last = s.slice(at).trim();
  if (last) out.push(last);
  return out;
}

export async function answer(
  db: Database.Database,
  question: string,
  opts: {
    model: string;
    /** Which model answers (src/harness/choose.ts). The local harness when absent. */
    asker?: Asker;
    via?: "local" | "cloud";
    limit?: number;
    timeoutMs?: number;
    documentId?: number;
    /**
     * Earlier turns of the conversation, most recent last, so "who voted against it?" knows what
     * "it" is. They arrive from the page and are used here in memory only (invariant 6). The last
     * two are enough and keep the prompt short for a small model.
     */
    earlier?: Array<{ question: string; answer: string }>;
  },
): Promise<Answer> {
  const earlier = (opts.earlier ?? []).slice(-2);
  // A follow-up often lacks the words that find its subject ("was it approved?"), so when the new
  // question alone finds nothing, the search borrows the previous question's words; the model is
  // still asked only the new question. Borrowing always pulled a complete new question back to the
  // last one's pages, and a small model answered the last question again (2026-09-30).
  const searchFor = retrieve(db, question, 1, opts.documentId).length || !earlier.length
    ? question
    : [earlier.at(-1)!.question, question].join(" ").trim();
  const got = await retrieveHybridReporting(db, searchFor, { limit: opts.limit ?? ANSWER_PASSAGES, documentId: opts.documentId });
  const found = got.passages.map((p) => narrow(p, searchFor));
  if (!found.length) {
    return {
      question,
      sentences: [],
      passages: [],
      model: opts.model,
      via: opts.via ?? "local",
      retrieval: got.vector,
      note:
        "Nothing in the record matched those words. That is a statement about the record, not about the world. " +
        searchNote(got.vector),
    };
  }

  const prompt =
    (earlier.length
      ? "EARLIER IN THIS CONVERSATION, only to work out what the new question refers to. Answer the NEW " +
        "question; do not repeat an earlier answer. Cite only the passages below:\n" +
        earlier.map((t) => `Q: ${t.question}\nA: ${t.answer}`).join("\n") + "\n\n"
      : "") +
    `QUESTION: ${question}\n\nPASSAGES:\n` +
    found
      .map((p) => `[${p.id}] ${documentLabel(p.filename).label}, page ${p.page_no}${p.meeting ? ` (${p.meeting})` : ""}\n${p.text}`)
      .join("\n\n");

  const res = await (opts.asker ?? ask)<{ sentences: Array<{ text: string; receipts: string[] }> }>({
    model: opts.model,
    system: SYSTEM,
    prompt,
    format: SCHEMA,
    timeoutMs: opts.timeoutMs ?? 300_000,
    // CALIBRATE: 2,048 tokens is an estimate of several times a long answer (about ten short
    // sentences with their receipts), not a measured maximum. A model that loops under a schema ran to
    // the five-minute timeout on 5 of 12 questions (qwen3:8b, 2026-09-30); with a cap it stops in
    // seconds and is reported as a reply cut off.
    maxTokens: ANSWER_MAX_TOKENS,
  });

  if (!res.ok) {
    return {
      question,
      sentences: [],
      passages: found,
      model: opts.model,
      via: opts.via ?? "local",
      retrieval: got.vector,
      failure: `${res.failure.kind}: ${res.failure.detail}`,
      note:
        "The model did not answer. The passages it would have been given are below, which is the " +
        "record itself and does not need a model.",
    };
  }

  const byId = new Map(found.map((p) => [p.id, p]));
  const out: Sentence[] = [];
  for (const raw of res.value.sentences ?? []) {
    const receipts = (raw.receipts ?? []).map(String).filter((r) => byId.has(r));
    // One returned "sentence" may be a paragraph. Each real sentence carries the same receipts and
    // is checked on its own, because a paragraph that is 80% supported is not a supported sentence.
    for (const piece of splitSentences(stripCitationMarkers(String(raw.text ?? "")))) {
      const cited = receipts.map((r) => byId.get(r)!).filter(Boolean);
      const verdict = checkSentence(piece, cited);
      out.push(
        verdict.ok
          ? { text: piece, receipts, kept: true }
          : { text: piece, receipts, kept: false, dropped_because: verdict.why },
      );
    }
  }

  const kept = out.filter((s) => s.kept).length;
  return {
    question,
    sentences: out,
    passages: found,
    model: opts.model,
    via: opts.via ?? "local",
    served_by: res.served_by,
    retrieval: got.vector,
    note:
      `${kept} of ${out.length} sentences carried a receipt that checks out. ` +
      `A receipt says the value is in the passage, not that the passage supports the sentence: ` +
      `only you can say that, which is why the passage is shown beside each one. ` +
      searchNote(got.vector),
  };
}

/**
 * What the search did, in the reader's words rather than the code's.
 *
 * Only one of these is a warning, and it is the one that used to be invisible: an embedding model
 * that did not answer narrowed the search to words alone, and nothing said so, so a question whose
 * answer lives on a page sharing none of its words came back "nothing matched" as though that were
 * a fact about the record.
 */
export function searchNote(v: VectorHalf): string {
  switch (v.state) {
    case "used":
      return v.added
        ? `The search also looked by meaning and added ${v.added} passage(s) the words missed.`
        : "The search also looked by meaning and found nothing the words had missed.";
    case "not indexed":
      return "The search used words only: nothing in this record has been indexed by meaning yet.";
    case "no room":
      return "The search used words only: the words filled every slot, so nothing was looked up by meaning.";
    case "unavailable":
      return (
        "**The search used words only, because the embedding model did not answer** " +
        `(${v.detail}). A question whose answer is on a page sharing none of its words can be missed ` +
        "this way. This is an instrument failure, not a finding about the record."
      );
  }
}
