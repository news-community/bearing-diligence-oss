/**
 * What is new in a folder since it was last opened, for the card at the top of a conversation.
 *
 * Everything here is computed by code from what the record already holds: the dates documents were
 * added, and what their change records found when they were read. The suggested questions are built
 * from those changes and never from anything asked before, because nothing asked before exists
 * unless the person saved it (invariant 6).
 */
import type { Record as OpenRecord } from "../record/db.js";
import { groupChanges } from "../change/group.js";
import type { Change } from "../change/compare.js";
import { subjectLabel } from "../change/label.js";
import { identifiers } from "../change/patterns.js";
import { documentLabel } from "./doc-label.js";

export type WhatsNew = {
  since: string | null;
  documents: Array<{ id: number; filename: string; added_at: string; changes: number; label: string }>;
  changes: Array<{ kind: string; subject: string; label: string; pairs: Array<{ then: string; now: string }>; filename: string; document: string }>;
  suggestions: string[];
};

/**
 * Amounts that moved first, then what appears for the first time, then dates that moved: on six real
 * agendas a routine monthly item's rolling dates filled the card while a new contract never showed.
 */
const ORDER = "CASE ch.kind WHEN 'moved_figure' THEN 0 WHEN 'new_identifier' THEN 1 WHEN 'moved_date' THEN 2 ELSE 3 END";

export function whatsNew(rec: OpenRecord, since: string | null): WhatsNew {
  const documents = rec.db
    .prepare<[string | null, string | null], Omit<WhatsNew["documents"][number], "label"> & { first_page: string | null }>(
      `SELECT d.id, d.filename, d.added_at,
              (SELECT COUNT(*) FROM changes ch JOIN change_records cr ON cr.id = ch.change_record_id
                WHERE cr.document_id = d.id) AS changes,
              (SELECT substr(text, 1, 400) FROM pages WHERE document_id = d.id AND page_no = 1) AS first_page
         FROM documents d WHERE ? IS NULL OR d.added_at > ? ORDER BY d.added_at DESC`,
    )
    .all(since, since)
    .map(({ first_page, ...d }) => ({ ...d, label: documentLabel(d.filename, first_page).label }));
  const ids = documents.map((d) => d.id);
  const rows = ids.length
    ? rec.db
        .prepare<number[], Change & { filename: string }>(
          `SELECT ch.kind, ch.subject, ch.now_value, ch.then_value, ch.now_document_id, ch.now_page, ch.now_passage,
                  ch.then_document_id, ch.then_page, ch.then_passage, ch.count, ch.meetings, d.filename
             FROM changes ch JOIN change_records cr ON cr.id = ch.change_record_id
             JOIN documents d ON d.id = cr.document_id
            WHERE cr.document_id IN (${ids.map(() => "?").join(",")}) AND ch.kind != 'recurrence'
            ORDER BY ${ORDER}, d.added_at DESC`,
        )
        .all(...ids)
    : [];
  const changes = groupChanges(rows)
        // One line per subject, its most recent comparison, so one routine item cannot fill the card.
        .filter((c, i, all) => all.findIndex((o) => o.subject === c.subject) === i)
        .slice(0, 6)
        .map((c) => ({
          kind: c.kind, subject: c.subject, pairs: c.pairs, filename: c.filename, label: subjectLabel(c.subject),
          document: documents.find((d) => d.filename === c.filename)?.label ?? c.filename,
        }));
  // The card already offers what changed in the newest document, so the suggestions start from the
  // changes themselves rather than repeating it.
  const suggestions: string[] = [];
  for (const c of changes) {
    if (suggestions.length >= 3) break;
    const name = subjectLabel(c.subject.split("|")[0]!);
    const q = c.kind === "new_identifier" ? `What is ${name}?` : `What changed about ${name}?`;
    if (!suggestions.includes(q)) suggestions.push(q);
  }
  // A new folder has one or two packets and nothing to compare, which is exactly when a person
  // first arrives (an item on Thursday's agenda). Its questions then come from the newest packet's
  // own contents: what it covers, and the resolutions, contracts and ordinances it names.
  const newest = documents[0];
  if (newest && suggestions.length < 3) {
    suggestions.push(`What is on the agenda in ${newest.filename}?`);
    const text = rec.db
      .prepare<[number], { text: string }>("SELECT text FROM pages WHERE document_id = ? ORDER BY page_no")
      .all(newest.id)
      .map((p) => p.text)
      .join("\n");
    for (const id of identifiers(text)) {
      if (suggestions.length >= 3) break;
      if (id.kind === "agenda_item") continue;
      const q = `What is ${subjectLabel(id.id)}?`;
      if (!suggestions.includes(q)) suggestions.push(q);
    }
  }
  return { since, documents, changes, suggestions };
}
