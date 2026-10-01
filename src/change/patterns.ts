/**
 * What code can check, on its own, without a model: identifiers, figures and dates.
 *
 * Every pattern here is a guess about how one organization writes, which is why the plan budgets for
 * tuning them against real packets and rebuilding their controls there. A pattern that has only ever
 * been seen agreeing has not been shown to be a check.
 */

export type Identifier = { kind: string; id: string; start: number; end: number };
export type Figure = { kind: "money" | "percent" | "count"; raw: string; value: number; start: number; end: number };
export type DateHit = { raw: string; iso: string; start: number; end: number };

const ID_PATTERNS: Array<[string, RegExp]> = [
  ["resolution", /\bResolution\s+(?:No\.?\s*)?([0-9]{1,4}(?:[-‑/][0-9]{1,4}){0,3})/gi],
  ["ordinance", /\bOrdinance\s+(?:No\.?\s*)?([0-9]{1,4}(?:[-/][0-9]{1,4})?)/gi],
  ["docket", /\b(?:Docket|Case)\s+(?:No\.?\s*)?([A-Z]{0,3}[-\s]?[0-9]{2,6}(?:[-/][0-9]{1,4})?)/g],
  ["tariff", /\bTariff\s+(?:Advice\s+)?(?:No\.?\s*)?([0-9]{1,4}(?:[-/][0-9]{1,4})?)/gi],
  ["contract", /\b(?:Contract|Agreement|PO)\s+(?:No\.?\s*)?([A-Z0-9][-A-Z0-9]{3,})/g],
  ["agenda_item", /\b(?:Agenda\s+)?Item\s+([0-9]{1,2}(?:\.[0-9]{1,2})?[A-Za-z]?)\b/g],
];

export function identifiers(text: string): Identifier[] {
  const out: Identifier[] = [];
  for (const [kind, re] of ID_PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const id = (m[1] ?? "").trim();
      if (!id) continue;
      out.push({ kind, id: `${kind}:${normalizeId(id)}`, start: m.index, end: m.index + m[0].length });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function normalizeId(id: string): string {
  return id.replace(/\s+/g, "").replace(/‑/g, "-").toUpperCase();
}

const SCALE: Record<string, number> = {
  k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9,
};

/**
 * Money, percentages and bare counts, normalised to a number so that $1,200,000 and $1.2 million are
 * the same figure. The case built to fail is exactly this: a figure that moved, written in a
 * different format, which a string comparison would call unchanged.
 */
export function figures(text: string): Figure[] {
  const out: Figure[] = [];
  // Longest alternative first: with `m` before `million`, the regex matches "$1.4 m" and the value
  // is right while the raw text shown beside the change is wrong.
  const money = /\$\s?([0-9][0-9,]*(?:\.[0-9]+)?)\s*(thousand|million|billion|bn|mm|k|m|b)?\b/gi;
  for (let m = money.exec(text); m; m = money.exec(text)) {
    const n = Number((m[1] ?? "").replace(/,/g, ""));
    if (!isFinite(n)) continue;
    const scale = m[2] ? SCALE[m[2].toLowerCase()] ?? 1 : 1;
    out.push({ kind: "money", raw: m[0].trim(), value: n * scale, start: m.index, end: m.index + m[0].length });
  }
  const pct = /([0-9][0-9,]*(?:\.[0-9]+)?)\s?(?:%|percent\b)/gi;
  for (let m = pct.exec(text); m; m = pct.exec(text)) {
    const n = Number((m[1] ?? "").replace(/,/g, ""));
    if (!isFinite(n)) continue;
    out.push({ kind: "percent", raw: m[0].trim(), value: n, start: m.index, end: m.index + m[0].length });
  }
  return out.sort((a, b) => a.start - b.start);
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const DAYS_IN = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** A date that cannot exist is not a date. "February 31, 2026" became a change subject until this. */
function realDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  if (day > (DAYS_IN[month - 1] ?? 31)) return false;
  if (month === 2 && day === 29) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return true;
}

export function dates(text: string): DateHit[] {
  const out: DateHit[] = [];
  // Case-insensitive on the month, because a heading is often all capitals and "MARCH 5, 2026"
  // was invisible to the change record.
  const named = /\b([A-Za-z]{3,9})\.?\s+([0-9]{1,2}),?\s+((?:19|20)[0-9]{2})\b/g;
  for (let m = named.exec(text); m; m = named.exec(text)) {
    const mo = MONTHS[(m[1] ?? "").toLowerCase()];
    const day = Number(m[2]);
    const year = Number(m[3]);
    if (!mo || !realDate(year, mo, day)) continue;
    const iso = `${year}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    out.push({ raw: m[0], iso, start: m.index, end: m.index + m[0].length });
  }
  const numeric = /\b([01]?[0-9])\/([0-3]?[0-9])\/((?:19|20)[0-9]{2})\b/g;
  for (let m = numeric.exec(text); m; m = numeric.exec(text)) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    const year = Number(m[3]);
    if (!realDate(year, month, day)) continue;
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    out.push({ raw: m[0], iso, start: m.index, end: m.index + m[0].length });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * The sentence a hit sits in, which is what gets shown beside a change.
 *
 * The two offsets are not always in order: a figure can appear BEFORE the identifier it belongs to,
 * as it does when a vote line repeats a resolution number further down the page. The first version
 * assumed start < end, sliced backwards and returned an EMPTY STRING, which made "both passages
 * side by side" quietly show one. Found by running two real PDFs through it.
 */
export function passageAround(text: string, start: number, end: number, pad = 160): string {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const from = Math.max(0, text.lastIndexOf(".", lo - 1) + 1);
  const dot = text.indexOf(".", hi);
  const to = dot === -1 ? Math.min(text.length, hi + pad) : Math.min(text.length, dot + 1);
  return text.slice(from, to).replace(/\s+/g, " ").trim();
}

/**
 * The paragraph a hit sits in, which is the unit a figure is attributed to.
 *
 * A sentence is the wrong unit twice over, and the fixtures found both. "$1.4 million" contains a
 * period, so a sentence splitter that stops at any dot cuts the figure off from the identifier that
 * introduces it. And a heading with no period at all runs into the first item, which paired a
 * meeting date with the first agenda item. A paragraph is bounded by a blank line, which both of
 * those respect.
 *
 * The cost is stated rather than hidden: a paragraph naming two identifiers attributes its figures
 * to both. The passage is shown beside every change, so the reader can see which one it belongs to.
 */
export function paragraphBounds(text: string, start: number, end: number): [number, number] {
  // A unit ends at a blank line or where a numbered item begins ("5. Approve..."). Text taken from
  // a PDF often has no blank lines at all, so a whole agenda page was one paragraph and every date
  // on it paired with every resolution (2026-09-30, six real board agendas).
  const boundary = /\n\s*\n|\n[ \t]*\d{1,2}\.[ \t]/g;
  let before = 0;
  let after = text.length;
  for (let m = boundary.exec(text); m; m = boundary.exec(text)) {
    if (m.index + m[0].length <= start) before = m.index + (m[0].startsWith("\n\n") || /^\n\s*\n/.test(m[0]) ? m[0].length : 1);
    else if (m.index >= end) { after = m.index; break; }
  }
  return [before, after];
}

/**
 * Whether the offset sits on a heading line.
 *
 * A packet's own meeting date lives in a heading, and pairing it with the first item below reports
 * "October 15 became April 9" about a contract, which is the meeting moving rather than the work.
 * This fired twice: once on a text fixture where a heading with no period ran into the first item,
 * and again on a PDF where uniform line spacing makes the whole page one paragraph.
 *
 * A heading here is a short line that is mostly capitals. CALIBRATE: 0.6 and 110 characters are
 * working assumptions from generated documents, and a real packet will move them.
 */
export function onHeadingLine(text: string, offset: number): boolean {
  const from = text.lastIndexOf("\n", offset - 1) + 1;
  const nl = text.indexOf("\n", offset);
  const line = text.slice(from, nl === -1 ? text.length : nl);
  if (line.length === 0 || line.length > 110) return false;
  const letters = line.replace(/[^A-Za-z]/g, "");
  if (letters.length < 4) return false;
  const caps = line.replace(/[^A-Z]/g, "").length;
  return caps / letters.length > 0.6;
}
