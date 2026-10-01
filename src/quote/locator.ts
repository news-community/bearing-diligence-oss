/**
 * The quote gate: code proves every quoted span exists, and says which way it failed.
 *
 * Ported in shape from an earlier Apache-2.0 locator (see THIRD_PARTY_NOTICES.md), rebuilt here rather than called,
 * and its fixtures are NOT copied. Five verdicts, because "did not locate" is four different
 * findings and a caller that gets one boolean cannot tell them apart:
 *
 *   located     the span is in the source, once, and it is long enough to assert anything
 *   absent      the span is not in the source: the model wrote it
 *   ambiguous   the span is in the source more than once, so it points at no single place
 *   recombined  real fragments joined across a boundary they do not share, which reads as one
 *               quotation and is not one
 *   too_short   under the floor, where a match proves nothing
 *
 * An ellipsis that crosses a sentence is refused (proposal, invariant 3). A quote may elide inside
 * one sentence; it may not silently join two.
 */
export type Verdict = "located" | "absent" | "ambiguous" | "recombined" | "too_short";

export type Located = {
  verdict: Verdict;
  start: number;
  end: number;
  detail: string;
  fragments: Array<{ text: string; start: number; end: number }>;
};

/** CALIBRATE. A quote under this many characters matches too easily to be evidence. */
export const MIN_QUOTE_CHARS = 24;

const ELLIPSIS = /\s*(?:…|\.\.\.)\s*/;

/** Normalise only what printing and copying change: whitespace, quote marks, dashes. */
export function normalise(s: string): string {
  return s
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/ /g, " ")
    .replace(/-[^\S\n]*\n\s*/g, "-") // a line broken after a hyphen, as buildMap reads it
    .replace(/\s+/g, " ")
    .trim();
}

/** Offsets in the normalised string mapped back to the original, so a passage can be shown. */
function buildMap(source: string): { norm: string; map: number[] } {
  const map: number[] = [];
  let norm = "";
  let lastWasSpace = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    let out = ch;
    if (/[‘’ʼ]/.test(ch)) out = "'";
    else if (/[“”]/.test(ch)) out = '"';
    else if (/[\u2013\u2014]/.test(ch)) out = "-";
    else if (ch === " ") out = " ";
    if (/\s/.test(out)) {
      if (lastWasSpace || norm.length === 0) continue;
      // A line break straight after a hyphen is where the PDF wrapped a word or a web address, not
      // a space in the text: six of 22 refusals on six real agendas were one address broken this way.
      // A hyphen followed by an ordinary space keeps the space.
      if (norm.endsWith("-") && /^\s*\n/.test(source.slice(i))) {
        while (i + 1 < source.length && /\s/.test(source[i + 1]!)) i++;
        continue;
      }
      out = " ";
      lastWasSpace = true;
    } else {
      lastWasSpace = false;
    }
    norm += out;
    map.push(i);
  }
  while (norm.endsWith(" ")) {
    norm = norm.slice(0, -1);
    map.pop();
  }
  return { norm, map };
}

function occurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    out.push(at);
    at = haystack.indexOf(needle, at + 1);
  }
  return out;
}

/**
 * A sentence end, and the two ways the first version got it wrong.
 *
 * It required whitespace immediately after the stop, so `completed in full." The board then...`
 * was NOT a sentence end and an ellipsis could join two sentences across it and be stored as
 * located. Quoted speech and parentheticals are ordinary in minutes, so the gate failed open on
 * exactly the material it is for.
 *
 * And it treated every `. ` as a stop, so `Res. No. 2026-14` made an elided quote inside ONE
 * sentence read as recombined: a true claim refused with a specific false accusation about the
 * model. Abbreviations and single initials are excluded by name.
 */
const ABBREVIATION = /\b(?:Res|No|Nos|Mr|Mrs|Ms|Dr|Prof|Sec|Art|Inc|Ltd|Co|Corp|St|Ave|Rd|Dept|Fig|Vol|Jr|Sr|[A-Z])\.$/;

function sentenceEndsIn(text: string): boolean {
  for (const m of text.matchAll(/[.!?](["'\u201D\u2019)\]]*)(?=\s|$)/g)) {
    // A stop followed by a closing bracket or quote is a sentence end even when what precedes it
    // looks like an initial: "(see Attachment A.)" ends a sentence and "Attachment A." alone does
    // not, and the closing character is the only thing that tells them apart.
    if (!m[1] && ABBREVIATION.test(text.slice(0, (m.index ?? 0) + 1))) continue;
    return true;
  }
  return false;
}

export function locate(quote: string, source: string): Located {
  const { norm, map } = buildMap(source);
  const q = normalise(quote);
  const none = { start: -1, end: -1, fragments: [] as Located["fragments"] };

  if (q.length < MIN_QUOTE_CHARS) {
    return { verdict: "too_short", ...none, detail: `${q.length} characters is under the ${MIN_QUOTE_CHARS} floor` };
  }

  const parts = q.split(ELLIPSIS).map((p) => p.trim()).filter(Boolean);

  if (parts.length === 1) {
    // Search for the part WITHOUT its ellipsis, not the raw quote. A model routinely ends a quote
    // with "..." to mean "and it goes on", and searching for the marker itself refused 28 quotes as
    // absent on one long run whose text was sitting right there. That is recall lost to the gate,
    // which is a refusal caused by the check rather than by the model.
    const core = parts[0]!;
    if (core.length < MIN_QUOTE_CHARS) {
      return { verdict: "too_short", ...none, detail: `${core.length} characters is under the ${MIN_QUOTE_CHARS} floor` };
    }
    const hits = occurrences(norm, core);
    if (hits.length === 0) return { verdict: "absent", ...none, detail: "the span is not in the source" };
    if (hits.length > 1) {
      return { verdict: "ambiguous", ...none, detail: `the span appears ${hits.length} times, so it points at no one place` };
    }
    const s = hits[0]!;
    return {
      verdict: "located",
      start: map[s]!,
      end: (map[s + core.length - 1] ?? map[map.length - 1]!) + 1,
      detail: core === q ? "located once" : "located once, with a trailing or leading ellipsis the source continues past",
      fragments: [{ text: core, start: map[s]!, end: (map[s + core.length - 1] ?? 0) + 1 }],
    };
  }

  // An elided quote. Every fragment must locate exactly once, in order, and the material between
  // them must not contain a sentence end: eliding inside a sentence is a quotation, eliding across
  // one is a new sentence the source never wrote.
  const found: Array<{ text: string; ns: number; ne: number }> = [];
  let cursor = 0;
  for (const part of parts) {
    if (part.length < 8) {
      return { verdict: "too_short", ...none, detail: `an elided fragment of ${part.length} characters proves nothing` };
    }
    const hits = occurrences(norm, part).filter((h) => h >= cursor);
    if (hits.length === 0) return { verdict: "absent", ...none, detail: `the fragment "${part.slice(0, 40)}" is not in the source in order` };
    if (occurrences(norm, part).length > 1 && found.length === 0 && hits.length > 1) {
      return { verdict: "ambiguous", ...none, detail: `the fragment "${part.slice(0, 40)}" appears more than once` };
    }
    const ns = hits[0]!;
    found.push({ text: part, ns, ne: ns + part.length });
    cursor = ns + part.length;
  }
  for (let i = 1; i < found.length; i++) {
    const between = norm.slice(found[i - 1]!.ne, found[i]!.ns);
    if (sentenceEndsIn(between)) {
      return {
        verdict: "recombined",
        ...none,
        detail: "the ellipsis crosses a sentence, so two real fragments were joined into one that was never written",
      };
    }
  }
  const first = found[0]!;
  const last = found[found.length - 1]!;
  return {
    verdict: "located",
    start: map[first.ns]!,
    end: (map[last.ne - 1] ?? map[map.length - 1]!) + 1,
    detail: `located as ${found.length} fragments inside one sentence`,
    fragments: found.map((f) => ({ text: f.text, start: map[f.ns]!, end: (map[f.ne - 1] ?? 0) + 1 })),
  };
}

/**
 * Per-source controls, built from the source's own text BEFORE any model runs.
 *
 * A source that cannot arm all three is marked NOT COVERED rather than passed: a gate that was
 * never shown able to fail on this material has not been shown to work on it.
 */
export type Controls =
  | { armed: true; accepts: string; refusesInvented: string; refusesJoined: string }
  | { armed: false; why: string };

export function controlsFor(source: string): Controls {
  const { norm } = buildMap(source);
  const sentences = norm.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length >= MIN_QUOTE_CHARS + 8);
  if (sentences.length < 2) {
    return { armed: false, why: "fewer than two sentences long enough to build a control from" };
  }
  const first = sentences[0]!.trim();
  const last = sentences[sentences.length - 1]!.trim();
  const accepts = first.slice(0, Math.max(MIN_QUOTE_CHARS + 6, Math.floor(first.length * 0.6)));
  const invented = "the board voted to relocate the substation to a barge moored offshore";
  const joined = `${first.slice(0, 30)} ... ${last.slice(-30)}`;
  if (norm.includes(invented)) return { armed: false, why: "the invented control appears in the source" };
  return { armed: true, accepts, refusesInvented: invented, refusesJoined: joined };
}

export function controlsPass(source: string): { covered: boolean; detail: string } {
  const c = controlsFor(source);
  if (!c.armed) return { covered: false, detail: `not covered: ${c.why}` };
  const a = locate(c.accepts, source);
  const b = locate(c.refusesInvented, source);
  const d = locate(c.refusesJoined, source);
  const problems: string[] = [];
  if (a.verdict !== "located") problems.push(`a real span was not located (${a.verdict})`);
  if (b.verdict !== "absent") problems.push(`an invented span was not refused (${b.verdict})`);
  // The joined control has to be refused FOR THE RIGHT REASON. Accepting any verdict but "located"
  // counted a control that failed for an unrelated reason as one that worked: a window whose first
  // sentence repeats, which recitals do, made the joined control ambiguous and every claim in that
  // window was then accepted on the strength of a control that never tested recombination.
  if (d.verdict === "located") problems.push("two joined fragments were accepted as one quotation");
  else if (d.verdict !== "recombined" && d.verdict !== "absent") {
    problems.push(`the joined control came back ${d.verdict}, so it never tested recombination here`);
  }
  return problems.length
    ? { covered: false, detail: `not covered: ${problems.join("; ")}` }
    : { covered: true, detail: "all three controls armed and behaving" };
}

/**
 * Where on a page a quote that was not found comes closest, so a person judging a refusal is shown
 * the page with the likeliest stretch marked rather than asked to search it. Words are compared
 * without case or punctuation, over a window the quote's length: the stretch sharing the most words
 * wins. It is a pointer for a reader and never evidence; the verdict stays the locator's.
 */
export function nearest(quote: string, source: string): { start: number; end: number; shared: number } | null {
  const word = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const q = normalise(quote).split(" ").map(word).filter(Boolean);
  const tokens = [...source.matchAll(/\S+/g)].map((m) => ({ w: word(m[0]), start: m.index!, end: m.index! + m[0].length }));
  if (!q.length || !tokens.length) return null;
  const want = new Map<string, number>();
  for (const w of q) want.set(w, (want.get(w) ?? 0) + 1);
  // Half again the quote's length, because a page carries words the quote dropped (item numbers,
  // a line's own heading); the result is trimmed to the first and last word that matched.
  const n = Math.min(Math.ceil(q.length * 1.5) + 2, tokens.length);
  let best = { first: 0, last: 0, score: -1 };
  for (let i = 0; i + n <= tokens.length; i++) {
    const have = new Map(want);
    let score = 0, first = -1, last = -1;
    for (let j = i; j < i + n; j++) {
      const left = have.get(tokens[j]!.w) ?? 0;
      if (left > 0) {
        score++;
        have.set(tokens[j]!.w, left - 1);
        if (first === -1) first = j;
        last = j;
      }
    }
    if (score > best.score || (score === best.score && first !== -1 && last - first < best.last - best.first)) {
      best = { first: first === -1 ? i : first, last: last === -1 ? i : last, score };
    }
  }
  const shared = best.score / q.length;
  return { start: tokens[best.first]!.start, end: tokens[best.last]!.end, shared };
}
