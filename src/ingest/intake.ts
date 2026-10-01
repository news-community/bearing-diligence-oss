/**
 * Taking a document all the way in, in ONE place.
 *
 * There were two entry points and they did different things. The command line read a packet with
 * OCR and read the votes off the page; the desktop shell, which is the only surface a person will
 * ever touch, did neither. Both were correct code and both were tested. Nothing compared them,
 * because a test of the CLI passes whatever the app does.
 *
 * So the sequence lives here and both callers run it. `src/gates/gates.ts` has a gate that fails if
 * `addDocument` is reached from anywhere but this module, because the way this defect returns is
 * somebody adding a third entry point that starts with the easy half.
 *
 * The order matters and each step says why:
 *   1. add          the bytes, the digest, the pages, the text layer
 *   2. OCR          pages with no text layer are UNREAD, not empty, and this is what fills them
 *   3. votes        read off the page by code, before any model sees the document (invariant 3)
 *   3b. commitments what somebody undertook to do, also read by code, also before the model. It was
 *                   built and tested on 2026-09-22 and reached by nothing but its own test until
 *                   the same day: code that is written and tested and reached by nothing.
 *   3c. screen      invariant 9. Text that reads as an instruction to a machine, and text a reader
 *                   would not see, are MARKED. Nothing is removed and nothing is reordered: the
 *                   mark is a disclosure to the reader. It runs before the model for the reader's sake rather than
 *                   for the model's, because the extraction call has already seen the document and
 *                   screening was never the defence (the defence is the empty tool list and the
 *                   located quote).
 *   4. model        the reading, as claims that carry a located quote or are refused
 *   5. change       computed last, because it reads everything the four steps above wrote
 */
import type { Record as OpenRecord } from "../record/db.js";
import { addDocument, type AddResult } from "../record/store.js";
import { ingestDocument, type IngestResult, type IngestProgress } from "./pipeline.js";
import { computeChangeRecord, saveChangeRecord, type ChangeRecord } from "../change/compare.js";
import { detectVotes } from "../votes/detect.js";
import { detectCommitments } from "../commitments/detect.js";
import { ocrDocument, ocrEngine, type OcrOutcome } from "../extract/ocr.js";
import { isUp, startRuntime } from "../harness/runtime.js";
import { screenDocument, type ScreenOutcome } from "../screen/marks.js";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

export type IntakeOptions = {
  layer: "public" | "private";
  meeting?: string;
  date?: string;
  /** Undefined means do not read it with a model at all, which is what `--no-model` asks for. */
  model?: string;
  onProgress?: (p: IngestProgress) => void;
  onStep?: (note: string) => void;
};

export type IntakeResult = {
  added: AddResult;
  /** null when nothing needed OCR; a note with available:false when the engine is not installed. */
  ocr: (OcrOutcome & { ran: boolean }) | null;
  votes: number;
  commitments: number;
  screen: ScreenOutcome;
  ingest: IngestResult | null;
  change: ChangeRecord;
  change_record_id: number;
};

/**
 * Read the commitments off the page. Same rule as the votes: a re-reading replaces the last one.
 *
 * These are DRAFTS. The schema's `pairing_state` defaults to 'draft' and nothing here accepts one,
 * because an undertaking paired with an outcome is a judgment and judgment is the person's.
 */
export function readCommitments(rec: OpenRecord, documentId: number): number {
  const pages = rec.db
    .prepare<[number], { page_no: number; text: string }>("SELECT page_no, text FROM pages WHERE document_id = ?")
    .all(documentId);
  const insert = rec.db.prepare(
    "INSERT INTO commitments (document_id, page_no, text, passage, due) VALUES (?, ?, ?, ?, ?)",
  );
  const write = rec.db.transaction(() => {
    rec.db.prepare("DELETE FROM commitments WHERE document_id = ?").run(documentId);
    let n = 0;
    for (const p of pages) {
      for (const c of detectCommitments(p.text, p.page_no)) {
        insert.run(documentId, c.page_no, c.text, c.passage, c.due);
        n++;
      }
    }
    return n;
  });
  return write();
}

/** Read the votes off the page. Re-reading a document replaces what the last reading found. */
export function readVotes(rec: OpenRecord, documentId: number): number {
  const pages = rec.db
    .prepare<[number], { page_no: number; text: string }>("SELECT page_no, text FROM pages WHERE document_id = ?")
    .all(documentId);
  const insert = rec.db.prepare(
    `INSERT INTO votes (document_id, page_no, subject, shape, yes, no, abstain, absent, unanimous, body, passage, start_char, end_char)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const write = rec.db.transaction(() => {
    rec.db.prepare("DELETE FROM votes WHERE document_id = ?").run(documentId);
    let n = 0;
    for (const p of pages) {
      for (const v of detectVotes(p.text)) {
        insert.run(documentId, p.page_no, v.subject, v.shape, v.yes, v.no, v.abstain, v.absent,
                   v.unanimous ? 1 : 0, v.body, v.passage, v.start, v.end);
        n++;
      }
    }
    return n;
  });
  return write();
}

export async function intake(rec: OpenRecord, file: string, opts: IntakeOptions): Promise<IntakeResult> {
  const step = opts.onStep ?? (() => {});
  const added = await addDocument(rec, file, opts.layer, opts.meeting, opts.date);
  step(`${added.already_held ? "already held" : "added"}: pages ${added.pages}, with text ${added.pages_with_text}`);

  let ocr: (OcrOutcome & { ran: boolean }) | null = null;
  const unread = added.pages - added.pages_with_text;
  // OCR runs whenever a page has no text layer and an engine is installed. There is no switch: until
  // 2026-09-28 there was, the shell passed "auto" and the command line "off", and the same packet
  // was read two ways by the two entry points this module exists to make one.
  if (unread > 0) {
    const engine = ocrEngine();
    if (!engine.available) {
      // The pages themselves, not an empty list: "still unread: none" beside "no engine" was a
      // claim about the pages made by an instrument that never looked at them.
      const stillUnread = rec.db
        .prepare<[number], { page_no: number }>(
          "SELECT page_no FROM pages WHERE document_id = ? AND text_source = 'none' ORDER BY page_no",
        )
        .all(added.document_id)
        .map((p) => p.page_no);
      ocr = { engine: engine.version, pages_attempted: 0, pages_read: 0, pages_still_unread: stillUnread,
              note: engine.note, ran: false };
      step(`  ${engine.note}`);
    } else {
      const out = await ocrDocument(rec, added.document_id);
      ocr = { ...out, ran: true };
      step(`  OCR (${out.engine}): ${out.note}`);
    }
  }

  const votes = readVotes(rec, added.document_id);
  step(`  votes read from the page: ${votes}`);

  const commitments = readCommitments(rec, added.document_id);
  step(`  commitments read from the page: ${commitments}, all as drafts`);

  const screen = await screenDocument(
    rec,
    added.document_id,
    extname(file).toLowerCase() === ".pdf" ? readFileSync(file) : null,
  );
  if (screen.instructions || screen.hidden) {
    step(`  MARKED: ${screen.instructions} instruction-shaped, ${screen.hidden} hidden (${screen.hidden_in_the_record} of those reached the record)`);
  }

  let ingest: IngestResult | null = null;
  if (opts.model) {
    if (!(await isUp())) {
      step("  the runtime is not answering; starting it");
      await startRuntime();
    }
    ingest = await ingestDocument(rec, added.document_id, { model: opts.model, onProgress: opts.onProgress });
  }

  const change = computeChangeRecord(rec.db, added.document_id);
  const change_record_id = saveChangeRecord(rec.db, change);
  return { added, ocr, votes, commitments, screen, ingest, change, change_record_id };
}
