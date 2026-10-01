/**
 * A document's name as a person reads it: "March 19, 2026 · Agenda" rather than
 * `2026-03-19_Agenda_BOD-Mtg.pdf`, which truncates to nothing in a list.
 *
 * Only what the record can support. The date comes from the filename when it carries one, else from
 * the file's own date; the kind ("Agenda", "Minutes") only when the first page says so. A title
 * guessed from anything else would be a claim nothing in the record backs, so without a kind the
 * filename stays in the label.
 */
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export type DocumentLabel = { date: string | null; kind: string | null; label: string };

const spelled = (y: number, m: number, d: number) => `${MONTHS[m - 1]} ${d}, ${y}`;

export function documentLabel(filename: string, firstPageText?: string | null, modified?: number | null): DocumentLabel {
  const inName = /(20\d{2})-(\d{2})-(\d{2})/.exec(filename);
  let date: string | null = null;
  if (inName) {
    const [y, m, d] = [Number(inName[1]), Number(inName[2]), Number(inName[3])];
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) date = spelled(y, m, d);
  } else if (modified) {
    const t = new Date(modified);
    date = spelled(t.getFullYear(), t.getMonth() + 1, t.getDate());
  }
  // Minutes first: a set of minutes often mentions the agenda, and an agenda rarely says "minutes"
  // in its heading. Only the opening of the first page counts, where a document names itself.
  const opening = (firstPageText ?? "").slice(0, 400).toUpperCase();
  const kind = /\bMINUTES\b/.test(opening) ? "Minutes" : /\bAGENDA\b/.test(opening) ? "Agenda" : null;
  const label = date && kind ? `${date} · ${kind}` : date ? `${date} · ${filename}` : filename;
  return { date, kind, label };
}
