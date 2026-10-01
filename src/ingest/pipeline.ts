/**
 * Ingestion is a pipeline, not an agent skill.
 *
 * One structured-output call per window, no tools offered in either direction, a checkpoint after
 * every window so a timeout loses one window and not a night, and a fate for every line the model
 * proposed: a claim is either located in the text it came from, or it is in the ledger with the
 * reason it was refused. Nothing the model wrote is stored as a source (invariant 11).
 */
import type { Record as OpenRecord } from "../record/db.js";
import { ask } from "../harness/model.js";
import { controlsPass, locate } from "../quote/locator.js";
import { beat, endRun, startRun } from "../record/runs.js";
import { indexDocument } from "../answer/embed.js";

/**
 * `pages` is the pages this window actually CONTAINS, which is not the same as the span from
 * page_from to page_to. An unread page between two read ones falls inside the span and is not in
 * the window, and counting the span made coverage claim the model had read it. Found by a deletion
 * pass that could not observe the skip, which is its own kind of finding: a guard whose effect is
 * invisible is a guard whose effect is unverified.
 */
export type WindowPlan = { window_no: number; page_from: number; page_to: number; pages: number[]; text: string };
export type IngestProgress = {
  window_no: number;
  windows_total: number;
  kept: number;
  refused: number;
  failure?: string;
};
export type IngestResult = {
  document_id: number;
  windows_total: number;
  windows_completed: number;
  windows_failed: number;
  windows_empty: number;
  failure_kinds: string[];
  claims_kept: number;
  claims_refused: number;
  not_covered: number;
  pages_embedded: number;
  seconds: number;
};

/** CALIBRATE. Small enough that a 4B model keeps the whole window, large enough to hold an item. */
export const WINDOW_CHARS = 6000;

const CLAIM_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: { claim: { type: "string" }, quote: { type: "string" } },
        required: ["claim", "quote"],
      },
    },
  },
  required: ["claims"],
};

/**
 * The uniqueness sentence was added on 2026-09-22, after reading every refusal from a 250-page run:
 * 63 of 66 were eight boilerplate sentences repeated across items, refused because the quote
 * pointed at no single place. The gate was right and the claims were true, so the fix belongs here,
 * in what is asked for, rather than in what the gate accepts.
 */
const SYSTEM =
  "You read one part of a board packet and list what it states. Every claim must carry a quote " +
  "copied EXACTLY from the text, word for word, at least 24 characters long. **The quote must " +
  "appear ONLY ONCE in the text you were given**: if a sentence is repeated under several items, " +
  "start the quote earlier so it includes the item or resolution number that makes it unique. " +
  "Never write a quote that is not in the text. Never join two separate sentences into one quote. " +
  "If the part states nothing, return an empty list.";

export { SYSTEM as INGEST_SYSTEM };

export function planWindows(
  pages: Array<{ page_no: number; text: string; has_text_layer: number }>,
  windowChars = WINDOW_CHARS,
): WindowPlan[] {
  const out: WindowPlan[] = [];
  let buf = "";
  let from = -1;
  let last = -1;
  let held: number[] = [];
  const flush = () => {
    if (buf.trim().length === 0 || from === -1) return;
    out.push({ window_no: out.length + 1, page_from: from, page_to: last, pages: held, text: buf });
    buf = "";
    from = -1;
    held = [];
  };
  for (const p of pages) {
    if (!p.has_text_layer) continue; // unread, and reported as unread. Never silently skipped.
    if (buf.length + p.text.length > windowChars && buf.length > 0) flush();
    if (from === -1) from = p.page_no;
    last = p.page_no;
    held.push(p.page_no);
    buf += (buf ? "\n" : "") + p.text;
  }
  flush();
  return out;
}

export async function ingestDocument(
  rec: OpenRecord,
  documentId: number,
  opts: { model: string; windowChars?: number; onProgress?: (p: IngestProgress) => void; timeoutMs?: number },
): Promise<IngestResult> {
  const started = Date.now();
  const pages = rec.db
    .prepare<[number], { page_no: number; text: string; has_text_layer: number }>(
      "SELECT page_no, text, has_text_layer FROM pages WHERE document_id = ? ORDER BY page_no",
    )
    .all(documentId);
  const windows = planWindows(pages, opts.windowChars);

  // The run accounts for itself from here. If this process dies, the row it leaves behind says so,
  // because it carries a pid and a heartbeat and no outcome (src/record/runs.ts).
  const doc = rec.db
    .prepare<[number], { filename: string }>("SELECT filename FROM documents WHERE id = ?")
    .get(documentId);
  // A re-read REPLACES the previous one. Re-running on a held document used to add a second set of
  // claims, ledger rows and votes with nothing to tell them apart, and re-running after an
  // interrupted run is the natural thing to do when the record has just said one stopped.
  rec.db.transaction(() => {
    rec.db.prepare("DELETE FROM claims WHERE document_id = ?").run(documentId);
    rec.db.prepare("DELETE FROM ledger WHERE document_id = ?").run(documentId);
  })();

  const runId = startRun(rec.db, {
    document_id: documentId,
    filename: doc?.filename ?? "",
    model: opts.model,
    windows_total: windows.length,
  });

  const keepClaim = claimWriter(rec.db);
  const insertLedger = rec.db.prepare(
    `INSERT INTO ledger (document_id, window_no, claim_text, quote, verdict, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const checkpoint = rec.db.prepare(
    `UPDATE coverage SET pages_read = ?, windows_total = ?, windows_completed = ?, windows_failed = ?,
       failure_kinds = ?, seconds = ?, windows_empty = ? WHERE document_id = ?`,
  );

  let completed = 0;
  let failed = 0;
  let kept = 0;
  let refused = 0;
  let notCovered = 0;
  let empty = 0;
  const failureKinds: string[] = [];
  let pagesRead = 0;

  for (const w of windows) {
    const control = controlsPass(w.text);
    if (!control.covered) {
      notCovered++;
      insertLedger.run(documentId, w.window_no, "", "", "not_covered", control.detail, new Date().toISOString());
    }

    const res = await ask<{ claims: Array<{ claim: string; quote: string }> }>({
      model: opts.model,
      system: SYSTEM,
      prompt: `TEXT OF PAGES ${w.page_from} TO ${w.page_to}:\n\n${w.text}`,
      format: CLAIM_SCHEMA,
      timeoutMs: opts.timeoutMs ?? 300_000,
    });

    if (!res.ok) {
      failed++;
      if (!failureKinds.includes(res.failure.kind)) failureKinds.push(res.failure.kind);
      insertLedger.run(
        documentId, w.window_no, "", "", res.failure.kind, res.failure.detail, new Date().toISOString(),
      );
      opts.onProgress?.({ window_no: w.window_no, windows_total: windows.length, kept, refused, failure: res.failure.kind });
      checkpoint.run(pagesRead, windows.length, completed, failed, failureKinds.join(","), (Date.now() - started) / 1000, empty, documentId);
      beat(rec.db, runId, {
        current_window: w.window_no,
        current_pages: `pages ${w.page_from} to ${w.page_to}`,
        windows_completed: completed,
        windows_failed: failed,
        claims_kept: kept,
        claims_refused: refused,
        failure_kinds: failureKinds.join(","),
      });
      continue;
    }

    const claims = Array.isArray(res.value?.claims) ? res.value.claims : [];
    // Answered, with nothing in it. A different thing from a window that was never reached, and the
    // coverage line has to be able to say which.
    if (claims.length === 0) empty++;
    for (const c of claims) {
      const claimText = String(c?.claim ?? "").trim();
      const quote = String(c?.quote ?? "").trim();
      if (!claimText || !quote) {
        refused++;
        insertLedger.run(documentId, w.window_no, claimText, quote, "absent", "a claim arrived without a quote", new Date().toISOString());
        continue;
      }
      const hit = locate(quote, w.text);
      if (hit.verdict === "located" && control.covered) {
        kept++;
        keepClaim(documentId, pages, w, claimText, quote, hit, opts.model);
      } else {
        refused++;
        insertLedger.run(
          documentId, w.window_no, claimText, quote, hit.verdict,
          control.covered ? hit.detail : `${hit.detail}; and this window is ${control.detail}`,
          new Date().toISOString(),
        );
      }
    }
    completed++;
    pagesRead += w.pages.length;
    checkpoint.run(pagesRead, windows.length, completed, failed, failureKinds.join(","), (Date.now() - started) / 1000, empty, documentId);
    beat(rec.db, runId, {
      current_window: w.window_no,
      current_pages: `pages ${w.page_from} to ${w.page_to}`,
      windows_completed: completed,
      windows_failed: failed,
      claims_kept: kept,
      claims_refused: refused,
      failure_kinds: failureKinds.join(","),
    });
    opts.onProgress?.({ window_no: w.window_no, windows_total: windows.length, kept, refused });
  }

  // Index for retrieval last, so a failure here costs the index and never the claims.
  let embedded = 0;
  try {
    embedded = (await indexDocument(rec.db, documentId)).embedded;
  } catch (e) {
    opts.onProgress?.({
      window_no: windows.length, windows_total: windows.length, kept, refused,
      failure: `embedding: ${(e as Error).message}`,
    });
  }

  endRun(rec.db, runId, "finished", embedded ? `${embedded} pages indexed for retrieval` : "not indexed for retrieval");

  return {
    document_id: documentId,
    windows_total: windows.length,
    windows_completed: completed,
    windows_failed: failed,
    windows_empty: empty,
    failure_kinds: failureKinds,
    claims_kept: kept,
    claims_refused: refused,
    not_covered: notCovered,
    pages_embedded: embedded,
    seconds: (Date.now() - started) / 1000,
  };
}

/**
 * Writing a located quote as a claim, in one place: the page a claim belongs to is the page its
 * quote sits on, not the window's first page. Used by reading and by the re-check below, so the two
 * cannot disagree about where a claim lives.
 */
function claimWriter(db: OpenRecord["db"]) {
  const insert = db.prepare(
    `INSERT INTO claims (document_id, page_no, text, quote, start_char, end_char, verdict, window_no, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return (
    documentId: number,
    pages: Array<{ page_no: number; text: string; has_text_layer: number }>,
    w: WindowPlan,
    claimText: string,
    quote: string,
    hit: { verdict: string; start: number; end: number },
    model: string,
  ) => insert.run(documentId, pageOfOffset(pages, w, hit.start), claimText, quote, hit.start, hit.end, hit.verdict, w.window_no, model, new Date().toISOString());
}

/**
 * What the locator changed, named so a record re-checks its refusals once per change. Bump it when
 * the locator starts finding something it used to refuse.
 */
export const LOCATOR_REVISION = "2026-09-30 hyphen at a line break";

/**
 * Refusals the current locator finds, made claims. A refusal is stored when a document is read, so
 * a fix to the locator reached only documents read after it: on six real agendas, six refusals of
 * one web address would have stayed "absent" while the address sat on the page. Only unreviewed
 * `absent` rows are tried (a person's judgment is theirs), each in the window it was refused from,
 * rebuilt from the same pages by the same planner. Runs once per LOCATOR_REVISION.
 */
export function recheckRefusals(db: OpenRecord["db"]): { kept: number } {
  const done = db.prepare<[], { value: string }>("SELECT value FROM meta WHERE key = 'refusals_rechecked'").get();
  if (done?.value === LOCATOR_REVISION) return { kept: 0 };
  const rows = db
    .prepare<[], { id: number; document_id: number; window_no: number; claim_text: string; quote: string }>(
      `SELECT id, document_id, window_no, claim_text, quote FROM ledger
        WHERE verdict = 'absent' AND reviewed_verdict IS NULL AND quote != '' AND claim_text != ''`,
    )
    .all();
  const keepClaim = claimWriter(db);
  const drop = db.prepare("DELETE FROM ledger WHERE id = ?");
  let kept = 0;
  const windowsOf = new Map<number, { pages: Array<{ page_no: number; text: string; has_text_layer: number }>; windows: WindowPlan[] }>();
  db.transaction(() => {
    for (const r of rows) {
      if (!windowsOf.has(r.document_id)) {
        const pages = db
          .prepare<[number], { page_no: number; text: string; has_text_layer: number }>(
            "SELECT page_no, text, has_text_layer FROM pages WHERE document_id = ? ORDER BY page_no",
          )
          .all(r.document_id);
        windowsOf.set(r.document_id, { pages, windows: planWindows(pages) });
      }
      const { pages, windows } = windowsOf.get(r.document_id)!;
      const w = windows.find((x) => x.window_no === r.window_no);
      if (!w || !controlsPass(w.text).covered) continue;
      const hit = locate(r.quote, w.text);
      if (hit.verdict !== "located") continue;
      const model = db.prepare<[number], { model: string }>("SELECT model FROM claims WHERE document_id = ? LIMIT 1").get(r.document_id)?.model ?? "";
      keepClaim(r.document_id, pages, w, r.claim_text, r.quote, hit, model);
      drop.run(r.id);
      kept++;
    }
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('refusals_rechecked', ?)").run(LOCATOR_REVISION);
  })();
  return { kept };
}

function pageOfOffset(
  pages: Array<{ page_no: number; text: string; has_text_layer: number }>,
  w: WindowPlan,
  offset: number,
): number {
  if (offset < 0) return w.page_from;
  let seen = 0;
  for (const p of pages) {
    if (p.page_no < w.page_from || p.page_no > w.page_to || !p.has_text_layer) continue;
    const len = p.text.length + (seen === 0 ? 0 : 1);
    if (offset < seen + len) return p.page_no;
    seen += len;
  }
  return w.page_to;
}
