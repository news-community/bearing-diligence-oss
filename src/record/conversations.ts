/**
 * Saved conversations: invariant 6 as a choice per folder .
 *
 * A conversation lives in the page's memory and is gone when the app quits, unless the person saves
 * it or has switched on saving for this folder. Only then is anything written, and only here, in
 * the folder's own record. The setting is in the record's `meta` table for the same reason: it
 * belongs to the folder and travels with it. Deleting removes the rows and then compacts the file,
 * the way leaving a document out does, so the question leaves the disk and not only the table.
 */
import type { Record as OpenRecord } from "./db.js";
import { compact } from "./remove.js";

export type Turn = { question: string; asked_at: string; answer: unknown };
export type ConversationSummary = { id: number; started_at: string; title: string; turns: number };

const SETTING = "save_conversations";

export function savesConversations(rec: OpenRecord): boolean {
  return rec.db.prepare<[string], { value: string }>("SELECT value FROM meta WHERE key = ?").get(SETTING)?.value === "all";
}

export function setSavesConversations(rec: OpenRecord, on: boolean): void {
  rec.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(SETTING, on ? "all" : "off");
}

/**
 * Save a whole conversation, replacing an earlier save of the same one, so the page can save after
 * every answer without a second path. Returns its id for the next save.
 */
export function saveConversation(rec: OpenRecord, turns: Turn[], id?: number): number {
  if (!turns.length) throw new Error("an empty conversation has nothing to save");
  const title = turns[0]!.question.slice(0, 120);
  return rec.db.transaction(() => {
    let cid = id;
    if (cid && rec.db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(cid)) {
      rec.db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title, cid);
      rec.db.prepare("DELETE FROM turns WHERE conversation_id = ?").run(cid);
    } else {
      cid = Number(rec.db.prepare("INSERT INTO conversations (started_at, title) VALUES (?, ?)").run(turns[0]!.asked_at, title).lastInsertRowid);
    }
    const insert = rec.db.prepare("INSERT INTO turns (conversation_id, position, asked_at, question, answer_json) VALUES (?, ?, ?, ?, ?)");
    turns.forEach((t, i) => insert.run(cid, i, t.asked_at, t.question, JSON.stringify(t.answer ?? null)));
    return cid!;
  })();
}

export function listConversations(rec: OpenRecord): ConversationSummary[] {
  return rec.db
    .prepare<[], ConversationSummary>(
      `SELECT c.id, c.started_at, c.title, (SELECT COUNT(*) FROM turns t WHERE t.conversation_id = c.id) AS turns
         FROM conversations c ORDER BY c.started_at DESC`,
    )
    .all();
}

export function getConversation(rec: OpenRecord, id: number): { id: number; turns: Turn[] } {
  if (!rec.db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(id)) throw new Error("that conversation is not saved");
  const turns = rec.db
    .prepare<[number], { question: string; asked_at: string; answer_json: string }>(
      "SELECT question, asked_at, answer_json FROM turns WHERE conversation_id = ? ORDER BY position",
    )
    .all(id)
    .map((t) => ({ question: t.question, asked_at: t.asked_at, answer: JSON.parse(t.answer_json) }));
  return { id, turns };
}

/** Delete one saved conversation, then compact, so its questions leave the disk. */
export function deleteConversation(rec: OpenRecord, id: number): void {
  rec.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
  compact(rec);
}
