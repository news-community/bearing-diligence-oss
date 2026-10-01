/**
 * SYNTHETIC fixtures. Written here, by hand, on 2026-09-20.
 *
 * These are NOT any real board's material and no result on real material rests on them.
 * What they do is let the code be exercised and every refusal be shown able to fire.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PACKET_A = `
BOARD PACKET, REGULAR MEETING, March 12, 2026

Item 4.1 Resolution 2026-07 authorises the general manager to execute Contract PO-44821 for
substation rebuild work in an amount not to exceed $1,200,000. The work is scheduled to be complete
by October 15, 2026.

Item 4.2 Tariff Advice No. 118 proposes a rate increase of 3.5 percent effective July 1, 2026.

Item 5 Docket U-26-014 remains before the commission. Staff expect a decision in the third quarter.

MINUTES OF THE REGULAR MEETING

Resolution 2026-07 was approved on a vote of 5-2. Ayes: 5, Nays: 2, Absent: 0.
Motion to accept the consent agenda carried unanimously.
The Finance Committee recommended Item 4.2 by a vote of 3-1.
`.trim();

export const PACKET_B = `
BOARD PACKET, REGULAR MEETING, April 9, 2026

Item 4.1 Resolution 2026-07 authorises the general manager to execute Contract PO-44821 for
substation rebuild work in an amount not to exceed $1.4 million. The work is now scheduled to be
complete by December 3, 2026.

Item 4.2 Tariff Advice No. 118 proposes a rate increase of 3.5 percent effective July 1, 2026.

Item 6 Resolution 2026-11 establishes a reserve policy. Ordinance 14 is referenced for context.

MINUTES OF THE REGULAR MEETING

Resolution 2026-11 was adopted. Ayes: 6, Nays: 1, Abstaining: 0.
`.trim();

/** What a person reading those two packets by hand says changed. Written before the code ran. */
export const LABELS_B = {
  labeled_on: "2026-09-20",
  labeled_by: "the author of this repository, by hand, before any run",
  // Relabeled 2026-09-30: "agenda_item:6" was labeled new and 4.1 and 4.2 recurring, and an item
  // number names a different item at every meeting. Six real agendas showed "item 6" moving a date
  // from 2028 to April; an item number is local to its meeting and is no longer compared.
  new_identifiers: ["resolution:2026-11", "ordinance:14"],
  moved_figures: [
    { subject: "resolution:2026-07|money", then: "$1,200,000", now: "$1.4 million" },
  ],
  moved_dates: [{ subject: "resolution:2026-07|date", then: "2026-10-15", now: "2026-12-03" }],
  recurring: ["resolution:2026-07", "contract:PO-44821", "tariff:118"],
  unchanged_on_purpose: ["tariff:118|percent stays 3.5 percent, and its date stays July 1, 2026"],
};

/** The case built to fail: a figure that moved, written in a format a string comparison calls equal. */
export const MOVED_IN_ANOTHER_FORMAT = { then: "$1,200,000", now: "$1.2 million", shouldDiffer: false };

/** The case built to fail: a page with no text layer must be reported unread, never unchanged. */
export const PAGE_WITH_NO_TEXT = "";

/** The case built to fail: a unanimous motion has no names, and none may be invented. */
export const UNANIMOUS_ONLY = "The motion to adjourn carried unanimously.";

/**
 * Invariant 6's instrument, shared by test/retention.test.ts and the shell check in
 * test/shell-smoke.ts, so the word searched for and the way it is searched are one copy.
 *
 * The nonce is a word no board packet or fixture contains, so a hit is the question and nothing
 * else. The search reads every byte of every file under a folder, write-ahead log and shared-memory
 * file included, because a sibling's own review found deletion markers surviving in exactly those.
 */
export const NONCE = "zarquonbrindlewaxe";

export function everyByteUnder(dir: string): Array<{ path: string; bytes: Buffer }> {
  const out: Array<{ path: string; bytes: Buffer }> = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = lstatSync(p);
    if (s.isSymbolicLink()) continue;
    if (s.isDirectory()) out.push(...everyByteUnder(p));
    else if (s.isFile()) out.push({ path: p, bytes: readFileSync(p) });
  }
  return out;
}

export function findNonce(dir: string): string[] {
  return everyByteUnder(dir)
    .filter((f) => f.bytes.includes(NONCE))
    .map((f) => f.path);
}
