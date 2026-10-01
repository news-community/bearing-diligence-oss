/**
 * Writing invariant 9's marks, and reading them back for the reader.
 *
 * The one rule that governs this file: **a mark changes nothing about retrieval or ranking.** It is
 * written here, read by the surface that shows the packet, and by nothing else. The `marks`
 * table is separate from `pages` for that reason, and `src/gates/gates.ts` fails the build if the
 * retrieval or answering path names it at all.
 */
import type { Record as OpenRecord } from "../record/db.js";
import { screenInstructions } from "./instructions.js";
import { hiddenText } from "./hidden.js";

export type Mark = {
  id: number;
  page_no: number;
  kind: "instruction" | "hidden";
  reason: string;
  rule: string;
  text: string;
  detail: string;
  reached_the_record: boolean;
  /**
   * For an instruction mark: the same text is also hidden from a reader. This is the signal worth
   * more than either half. Instruction-shaped text in VISIBLE board prose is usually a coincidence
   * ("you must not report a conflict of interest"). The same sentence painted white is not a
   * coincidence, and the two screens share no code, so their agreement is worth stating.
   */
  also_hidden: boolean;
};

export type ScreenOutcome = {
  instructions: number;
  hidden: number;
  /** Hidden text that also reached the page text, which is the count that matters. */
  hidden_in_the_record: number;
  /** Marked as an instruction AND hidden from a reader: two independent screens agreeing. */
  both: number;
  note: string;
};

/**
 * Screen one document and record what was found.
 *
 * Re-reading a document replaces its marks, the same rule as the claims, the votes and the
 * commitments: a reading is a statement about the document as it is now.
 */
export async function screenDocument(
  rec: OpenRecord,
  documentId: number,
  bytes: Buffer | null,
): Promise<ScreenOutcome> {
  const pages = rec.db
    .prepare<[number], { page_no: number; text: string }>(
      "SELECT page_no, text FROM pages WHERE document_id = ? ORDER BY page_no",
    )
    .all(documentId);

  const insert = rec.db.prepare(
    `INSERT INTO marks (document_id, page_no, kind, reason, rule, text, detail, start_char, end_char, reached_the_record)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let instructions = 0;
  let hidden = 0;
  let hiddenInRecord = 0;

  // Hidden text is read from the PDF's drawing operators, so it needs the bytes rather than the
  // extracted text. A plain text file has no way to hide anything, and says so rather than being
  // silently skipped.
  const runs = bytes ? await hiddenText(bytes, new Map(pages.map((p) => [p.page_no, p.text]))) : [];

  const write = rec.db.transaction(() => {
    rec.db.prepare("DELETE FROM marks WHERE document_id = ?").run(documentId);
    for (const p of pages) {
      for (const s of screenInstructions(p.text, p.page_no)) {
        insert.run(documentId, s.page_no, "instruction", s.kind, s.rule, s.text, "", s.start, s.end, 1);
        instructions++;
      }
    }
    for (const r of runs) {
      insert.run(documentId, r.page_no, "hidden", r.reason, r.reason, r.text, r.detail, null, null, r.in_extracted ? 1 : 0);
      hidden++;
      if (r.in_extracted) hiddenInRecord++;
    }
  });
  write();

  const both = listMarks(rec.db, documentId, 1000).filter((m) => m.also_hidden).length;
  return {
    instructions,
    hidden,
    hidden_in_the_record: hiddenInRecord,
    both,
    note: note(instructions, hidden, hiddenInRecord, both, bytes !== null),
  };
}

function note(instructions: number, hidden: number, inRecord: number, both: number, couldCheckHidden: boolean): string {
  const parts: string[] = [];
  if (!instructions && !hidden) {
    parts.push("Nothing in this packet reads as an instruction to a machine, and no text is hidden from a reader.");
  }
  if (instructions) {
    parts.push(
      `${instructions} passage${instructions === 1 ? "" : "s"} read as an instruction to a machine. They are marked and NOTHING else changed: ` +
        `every one is still in the record, still searchable, and still ranked exactly as it was.`,
    );
  }
  if (hidden) {
    parts.push(
      `${hidden} passage${hidden === 1 ? " is" : "s are"} in this file and would not be visible to a ` +
        `reader, ${inRecord} of which also reached the page text this record holds. ` +
        (inRecord ? "Those are the ones worth reading." : "None of them reached the page text."),
    );
  }
  if (both) {
    parts.push(
      `**${both} of them ${both === 1 ? "is" : "are"} both**: text that reads as an instruction AND is ` +
        `painted where a reader cannot see it. The two screens share no code, so that is two ` +
        `independent readings agreeing, and it is the finding here least likely to be a coincidence.`,
    );
  }
  if (!couldCheckHidden) {
    parts.push("Hidden text was not checked: that reads a PDF's drawing operators and this is not a PDF.");
  }
  parts.push(
    "This is a disclosure, not a defence: the patterns are English only, their recall is unmeasured on real packets, " +
      "and the extraction call saw this document before any of it ran.",
  );
  return parts.join(" ");
}

/** What the reader reads. The only consumer of the marks, and never part of an answer. */
export function listMarks(db: OpenRecord["db"], documentId?: number, limit = 100): Mark[] {
  const rows = documentId
    ? db
        .prepare(
          `SELECT id, page_no, kind, reason, rule, text, detail, reached_the_record
             FROM marks WHERE document_id = ? ORDER BY page_no, id LIMIT ?`,
        )
        .all(documentId, limit)
    : db
        .prepare(
          `SELECT id, page_no, kind, reason, rule, text, detail, reached_the_record
             FROM marks ORDER BY document_id DESC, page_no, id LIMIT ?`,
        )
        .all(limit);
  const marks = (rows as any[]).map((r) => ({ ...r, reached_the_record: !!r.reached_the_record, also_hidden: false }));
  // Correlated at read time rather than stored, because it is derived from the other rows and a
  // stored copy of a derived fact is the thing this repository keeps finding gone stale.
  const hiddenOn = new Map<number, string[]>();
  for (const m of marks) {
    if (m.kind !== "hidden") continue;
    hiddenOn.set(m.page_no, [...(hiddenOn.get(m.page_no) ?? []), norm(m.text)]);
  }
  for (const m of marks) {
    if (m.kind !== "instruction") continue;
    m.also_hidden = (hiddenOn.get(m.page_no) ?? []).some((h) => h.includes(norm(m.text)));
  }
  return marks;
}

const norm = (s: string) => s.replace(/\s+/g, " ").toLowerCase().trim().replace(/[.,;:]+$/, "");
