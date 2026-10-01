/**
 * The change record: what a new packet changes against everything before it.
 *
 * Coverage first, always. A page with no extractable text is reported unread, never unchanged, and a
 * change record over an incompletely read packet says so in its first line rather than its last.
 * Nothing here asks a model anything: this is the half the product's claim rests on (docs/design.md, "The change record").
 */
import type Database from "better-sqlite3";
import { dates, figures, identifiers, onHeadingLine, paragraphBounds, passageAround } from "./patterns.js";

export type Observation = {
  subject: string;
  kind: "money" | "percent" | "date";
  value: number | string;
  raw: string;
  document_id: number;
  page_no: number;
  passage: string;
  added_at: string;
};

export type Coverage = {
  pages_total: number;
  pages_with_text: number;
  pages_unread: number[];
  pages_by_ocr: number[];
  /** Pages the MODEL read. Extraction reading a page and a model reading it are different events. */
  pages_read_by_model: number;
  windows_total: number;
  windows_failed: number;
  windows_empty: number;
  failure_kinds: string[];
  complete: boolean;
  note: string;
};

export type Change = {
  kind: "new_identifier" | "moved_figure" | "moved_date" | "recurrence";
  subject: string;
  now_value: string;
  then_value: string;
  now_document_id: number | null;
  now_page: number | null;
  now_passage: string;
  then_document_id: number | null;
  then_page: number | null;
  then_passage: string;
  count: number;
  meetings: string;
};

export type ChangeRecord = { document_id: number; compared_against: number; coverage: Coverage; changes: Change[] };

type PageRow = { document_id: number; page_no: number; text: string; has_text_layer: number; text_source: string };

/**
 * Identifiers that name something only within one meeting. "Item 6" is a different item at every
 * meeting, so comparing it across agendas reported a date moving from 2028 to April on the first
 * real packets tried (2026-09-30). They are still found on the page; they are never compared.
 */
const LOCAL_KINDS = new Set(["agenda_item"]);

function observationsFor(rows: PageRow[], addedAt: string): { obs: Observation[]; idsByDoc: Map<number, Set<string>> } {
  const obs: Observation[] = [];
  const idsByDoc = new Map<number, Set<string>>();
  for (const row of rows) {
    if (!row.has_text_layer && row.text_source !== "ocr") continue;
    const ids = identifiers(row.text);
    const figs = figures(row.text);
    const dts = dates(row.text);
    const set = idsByDoc.get(row.document_id) ?? new Set<string>();
    for (const id of ids) {
      if (LOCAL_KINDS.has(id.kind)) continue;
      set.add(id.id);
      // A figure or a date belongs to the identifier whose PARAGRAPH it shares (patterns.ts says
      // why a sentence is the wrong unit). Nothing pairs across a blank line, because that is a
      // judgment rather than a match.
      const [sentenceStart, sentenceEnd] = paragraphBounds(row.text, id.start, id.end);
      for (const f of figs) {
        if (f.start < sentenceStart || f.end > sentenceEnd) continue;
        if (onHeadingLine(row.text, f.start)) continue; // a heading is the packet's, not an item's
        if (f.kind === "count") continue; // a bare count has no subject of its own yet
        obs.push({
          subject: `${id.id}|${f.kind}`, kind: f.kind, value: f.value, raw: f.raw,
          document_id: row.document_id, page_no: row.page_no,
          passage: passageAround(row.text, id.start, f.end), added_at: addedAt,
        });
      }
      for (const d of dts) {
        if (d.start < sentenceStart || d.end > sentenceEnd) continue;
        if (onHeadingLine(row.text, d.start)) continue; // the meeting's own date, not a date that moved
        obs.push({
          subject: `${id.id}|date`, kind: "date", value: d.iso, raw: d.raw,
          document_id: row.document_id, page_no: row.page_no,
          passage: passageAround(row.text, id.start, d.end), added_at: addedAt,
        });
      }
    }
    idsByDoc.set(row.document_id, set);
  }
  return { obs, idsByDoc };
}

export function computeChangeRecord(db: Database.Database, documentId: number): ChangeRecord {
  const newPages = db
    .prepare<[number], PageRow>(
      "SELECT document_id, page_no, text, has_text_layer, text_source FROM pages WHERE document_id = ? ORDER BY page_no",
    )
    .all(documentId);
  const earlierPages = db
    .prepare<[number], PageRow>(
      // EARLIER documents only. This read every other document, which is right when a record is
      // computed as a document arrives and wrong when it is recomputed later: the January agenda
      // then reported changes "from" June's, found on 2026-09-30.
      `SELECT p.document_id, p.page_no, p.text, p.has_text_layer, p.text_source FROM pages p
         JOIN documents d ON d.id = p.document_id
         JOIN documents me ON me.id = ?
        WHERE d.id != me.id AND (d.added_at < me.added_at OR (d.added_at = me.added_at AND d.id < me.id))
        ORDER BY d.added_at, p.page_no`,
    )
    .all(documentId);

  // A page OCR read is READ, by a weaker instrument. A page nothing read is unread.
  const pagesUnread = newPages.filter((p) => !p.has_text_layer && p.text_source !== "ocr").map((p) => p.page_no);
  const pagesByOcr = newPages.filter((p) => p.text_source === "ocr").map((p) => p.page_no);

  // Extraction reading a page and a MODEL reading it are two different events, and a run where the
  // runtime dropped a window has pages that were extracted and never read. Reporting "every page
  // had extractable text" over such a run is true and misleading, which is risk 14 arriving in the
  // coverage line rather than in a finding. Found on a 250-page run where one window failed
  // unreachable and the change record still called itself complete.
  const run = db
    .prepare<[number], { pages_read: number; windows_total: number; windows_completed: number; windows_failed: number; windows_empty: number; failure_kinds: string }>(
      "SELECT pages_read, windows_total, windows_completed, windows_failed, windows_empty, failure_kinds FROM coverage WHERE document_id = ?",
    )
    .get(documentId);
  const windowsFailed = run?.windows_failed ?? 0;
  const failureKinds = (run?.failure_kinds ?? "").split(",").filter(Boolean);
  const modelRan = (run?.windows_total ?? 0) > 0;
  const pagesReadByModel = run?.pages_read ?? 0;

  const parts: string[] = [];
  if (pagesUnread.length) {
    parts.push(
      `${pagesUnread.length} of ${newPages.length} pages had no extractable text and were NOT read. ` +
        `Nothing below is a statement about them: they are unread, not unchanged.`,
    );
  } else {
    parts.push("Every page of this packet had extractable text.");
  }
  if (pagesByOcr.length) {
    parts.push(
      `${pagesByOcr.length} page(s) had no text layer and were read by OCR instead, so anything ` +
        `below that rests on them rests on a machine's reading of pixels.`,
    );
  }
  const windowsShort = (run?.windows_total ?? 0) - (run?.windows_completed ?? 0) - windowsFailed;
  if (windowsShort > 0) {
    parts.push(
      `${windowsShort} of ${run?.windows_total} windows were never reached, so this packet's reading ` +
        `did not finish. A run that stopped early and a run that found nothing look the same in a ` +
        `record that does not say which.`,
    );
  }
  if (windowsFailed > 0) {
    parts.push(
      `${windowsFailed} of ${run?.windows_total} windows FAILED (${failureKinds.join(", ") || "unknown"}), so the ` +
        `model read ${pagesReadByModel} of ${newPages.length} pages. What code checked below covers the whole ` +
        `packet; what the model read does not.`,
    );
  } else if (modelRan) {
    parts.push(`The model read ${pagesReadByModel} of ${newPages.length} pages across ${run?.windows_total} windows.`);
  }
  const emptyWindows = run?.windows_empty ?? 0;
  if (emptyWindows > 0) {
    parts.push(
      `${emptyWindows} of those windows were read and yielded NOTHING, which is different from not ` +
        `being read and different again from finding no change.`,
    );
  }

  const coverage: Coverage = {
    pages_total: newPages.length,
    pages_with_text: newPages.length - pagesUnread.length,
    pages_unread: pagesUnread,
    pages_by_ocr: pagesByOcr,
    pages_read_by_model: pagesReadByModel,
    windows_total: run?.windows_total ?? 0,
    windows_failed: windowsFailed,
    windows_empty: run?.windows_empty ?? 0,
    failure_kinds: failureKinds,
    complete: pagesUnread.length === 0 && windowsFailed === 0 && windowsShort <= 0,
    note: parts.join(" "),
  };

  const nowSide = observationsFor(newPages, new Date().toISOString());
  const thenSide = observationsFor(earlierPages, "");

  const earlierIds = new Set<string>();
  for (const set of thenSide.idsByDoc.values()) for (const id of set) earlierIds.add(id);
  const nowIds = new Set<string>();
  for (const set of nowSide.idsByDoc.values()) for (const id of set) nowIds.add(id);

  const changes: Change[] = [];

  for (const id of [...nowIds].sort()) {
    if (earlierIds.has(id)) continue;
    const first = nowSide.obs.find((o) => o.subject.startsWith(id + "|"));
    const page = first?.page_no ?? firstPageOf(newPages, id);
    changes.push({
      kind: "new_identifier", subject: id, now_value: "", then_value: "",
      now_document_id: documentId, now_page: page,
      now_passage: first?.passage ?? passageOf(newPages, id),
      then_document_id: null, then_page: null, then_passage: "", count: 0, meetings: "",
    });
  }

  const latestThen = new Map<string, Observation>();
  for (const o of thenSide.obs) {
    const held = latestThen.get(o.subject);
    // Rows arrive oldest first, so the newest wins, EXCEPT that an observation carrying a passage
    // beats one that does not: a change with nothing to show beside it is half the product.
    if (!held || o.passage.length > 0 || held.passage.length === 0) latestThen.set(o.subject, o);
  }
  for (const o of nowSide.obs) {
    const before = latestThen.get(o.subject);
    if (!before) continue;
    if (String(before.value) === String(o.value)) continue;
    changes.push({
      kind: o.kind === "date" ? "moved_date" : "moved_figure",
      subject: o.subject, now_value: o.raw, then_value: before.raw,
      now_document_id: documentId, now_page: o.page_no, now_passage: o.passage,
      then_document_id: before.document_id, then_page: before.page_no, then_passage: before.passage,
      count: 0, meetings: "",
    });
  }

  for (const id of [...nowIds].sort()) {
    if (!earlierIds.has(id)) continue;
    const docs = [...thenSide.idsByDoc.entries()].filter(([, set]) => set.has(id)).map(([d]) => d);
    changes.push({
      kind: "recurrence", subject: id, now_value: "", then_value: "",
      now_document_id: documentId, now_page: firstPageOf(newPages, id), now_passage: passageOf(newPages, id),
      then_document_id: docs[docs.length - 1] ?? null, then_page: null, then_passage: "",
      count: docs.length + 1, meetings: docs.join(","),
    });
  }

  return { document_id: documentId, compared_against: thenSide.idsByDoc.size, coverage, changes };
}

function firstPageOf(pages: PageRow[], id: string): number {
  for (const p of pages) if (identifiers(p.text).some((i) => i.id === id)) return p.page_no;
  return pages[0]?.page_no ?? 1;
}

function passageOf(pages: PageRow[], id: string): string {
  for (const p of pages) {
    const hit = identifiers(p.text).find((i) => i.id === id);
    if (hit) return passageAround(p.text, hit.start, hit.end);
  }
  return "";
}

/**
 * The header and its changes go in together or not at all.
 *
 * They used to be two writes: the `change_records` row committed on its own and the `changes` rows
 * followed in a separate transaction. Anything failing between them left a change record with no
 * changes, which reads as "this packet changed nothing" and is the single most expensive wrong
 * output this product can produce. It is also indistinguishable from a real empty result.
 */
export function saveChangeRecord(db: Database.Database, rec: ChangeRecord): number {
  const insertRec = db.prepare(
    "INSERT INTO change_records (document_id, created_at, compared_against, coverage_json) VALUES (?, ?, ?, ?)",
  );
  const insertChange = db.prepare(
    `INSERT INTO changes (change_record_id, kind, subject, now_value, then_value, now_document_id, now_page,
       now_passage, then_document_id, then_page, then_passage, count, meetings)
     VALUES (@rid, @kind, @subject, @now_value, @then_value, @now_document_id, @now_page, @now_passage,
       @then_document_id, @then_page, @then_passage, @count, @meetings)`,
  );
  const write = db.transaction((r: ChangeRecord): number => {
    const id = Number(
      insertRec.run(r.document_id, new Date().toISOString(), r.compared_against, JSON.stringify(r.coverage))
        .lastInsertRowid,
    );
    for (const c of r.changes) insertChange.run({ rid: id, ...c });
    return id;
  });
  return write(rec);
}
