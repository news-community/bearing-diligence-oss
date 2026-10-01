/**
 * Roll calls and tallies, read from the page and never inferred.
 *
 * Re-expressed from this tree's vote detectors, shape by shape. Regular expressions do not port
 * between Python and JavaScript unchanged, which is what the fixtures are for: every shape has a
 * fixture and the run aborts on any mismatch rather than reporting a rate.
 *
 * Two rules the detectors follow. A motion recorded only as "passed unanimously" is a vote with no
 * names, and inventing names for it is the failure its tests check for. And a committee's votes printed
 * inside a board packet belong to the committee, so the body is carried with the vote.
 */
export type Vote = {
  subject: string;
  shape: string;
  yes: number | null;
  no: number | null;
  abstain: number | null;
  absent: number | null;
  unanimous: boolean;
  body: string;
  passage: string;
  start: number;
  end: number;
};

const BODY_HINT =
  /\b((?:[A-Z][A-Za-z]+\s+)*(?:Committee|Subcommittee|Board|Commission|Council|Authority))\b/;

function bodyNear(text: string, at: number): string {
  const before = text.slice(Math.max(0, at - 400), at);
  const hits = [...before.matchAll(new RegExp(BODY_HINT, "g"))];
  const last = hits[hits.length - 1];
  return last ? last[1]!.trim() : "";
}

function subjectNear(text: string, at: number): string {
  const before = text.slice(Math.max(0, at - 300), at);
  const m = [...before.matchAll(/\b((?:Resolution|Ordinance|Item|Motion|Tariff)[^.\n]{0,80})/gi)];
  const last = m[m.length - 1];
  return last ? last[1]!.replace(/\s+/g, " ").trim() : "";
}

function around(text: string, start: number, end: number): string {
  const from = Math.max(0, text.lastIndexOf("\n", start - 1) + 1);
  const nl = text.indexOf("\n", end);
  return text.slice(from, nl === -1 ? Math.min(text.length, end + 120) : nl).replace(/\s+/g, " ").trim();
}

export function detectVotes(text: string): Vote[] {
  const out: Vote[] = [];
  const seen = new Set<number>();
  const push = (v: Vote) => {
    if (seen.has(v.start)) return;
    seen.add(v.start);
    out.push(v);
  };

  // Shape 1: an explicit tally, "4-1", "4 to 1", "4-1-2" (yes-no-abstain).
  //
  // The vote words alone are not enough, and that was measured: "approved as presented; the staff
  // report appears at pages 10-12" recorded a tally of yes 10, no 12, and "Section 4-2 of the
  // bylaws" recorded 4 to 2, in a module whose header says votes are read and never inferred. So
  // a number pair immediately preceded by a word that makes it something ELSE is refused.
  const NOT_A_TALLY = /\b(pages?|pp|section|sec|article|art|item|items|exhibit|attachment|table|figure|chapter|paragraph|clause|line|lines|rule|rules|part)\.?\s*$/i;
  const tally = /\b([0-9]{1,2})\s*(?:-|\u2013|to)\s*([0-9]{1,2})(?:\s*(?:-|\u2013)\s*([0-9]{1,2}))?\b/g;
  for (let m = tally.exec(text); m; m = tally.exec(text)) {
    const window = text.slice(Math.max(0, m.index - 120), m.index + 120).toLowerCase();
    if (!/\b(vote|motion|carried|passed|approved|failed|adopted|ayes?|nays?)\b/.test(window)) continue;
    if (NOT_A_TALLY.test(text.slice(Math.max(0, m.index - 40), m.index))) continue;
    push({
      subject: subjectNear(text, m.index), shape: "tally",
      yes: Number(m[1]), no: Number(m[2]), abstain: m[3] ? Number(m[3]) : null, absent: null,
      unanimous: false, body: bodyNear(text, m.index),
      passage: around(text, m.index, m.index + m[0].length), start: m.index, end: m.index + m[0].length,
    });
  }

  // Shape 2: named counts, "Ayes: 5, Nays: 2, Abstain: 1, Absent: 1" in any order.
  const named = /\b(Ayes?|Yeas?|Nays?|Noes?|Abstain(?:ing|ed)?|Absent|Excused)\b\s*[:\-]?\s*([0-9]{1,2})\b/gi;
  const groups: Array<{ start: number; end: number; counts: Record<string, number> }> = [];
  for (let m = named.exec(text); m; m = named.exec(text)) {
    const label = (m[1] ?? "").toLowerCase();
    const n = Number(m[2]);
    const last = groups[groups.length - 1];
    // A label already present means this is a NEW roll call, not a continuation of the last one.
    // Without that, "Item 5. Ayes: 5, Nays: 0. Item 6. Ayes: 3, Nays: 2." merged into one vote
    // reading 3 to 2 under Item 5's subject, and Item 6's vote vanished: a wrong answer and a
    // silent loss in the same row.
    if (last && m.index - last.end < 60 && !(label in last.counts)) {
      last.counts[label] = n;
      last.end = m.index + m[0].length;
    } else {
      groups.push({ start: m.index, end: m.index + m[0].length, counts: { [label]: n } });
    }
  }
  for (const g of groups) {
    const get = (...keys: string[]) => {
      for (const k of keys) {
        const v = Object.entries(g.counts).find(([label]) => label.startsWith(k));
        if (v) return v[1];
      }
      return null;
    };
    const yes = get("aye", "yea");
    const no = get("nay", "no");
    if (yes === null && no === null) continue;
    push({
      subject: subjectNear(text, g.start), shape: "named_counts",
      yes, no, abstain: get("abstain"), absent: get("absent", "excused"),
      unanimous: false, body: bodyNear(text, g.start),
      passage: around(text, g.start, g.end), start: g.start, end: g.end,
    });
  }

  // Shape 3: unanimous with no names. A vote, with nobody to attribute it to.
  const unanimous = /\b(?:motion\s+)?(?:carried|passed|approved|adopted|failed)\s+unanimously\b|\bunanimously\s+(?:carried|passed|approved|adopted)\b/gi;
  for (let m = unanimous.exec(text); m; m = unanimous.exec(text)) {
    push({
      subject: subjectNear(text, m.index), shape: "unanimous_no_names",
      yes: null, no: null, abstain: null, absent: null, unanimous: true,
      body: bodyNear(text, m.index), passage: around(text, m.index, m.index + m[0].length),
      start: m.index, end: m.index + m[0].length,
    });
  }

  return out.sort((a, b) => a.start - b.start);
}
