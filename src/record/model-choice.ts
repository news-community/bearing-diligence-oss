/**
 * Which model answers in this folder, kept in the folder's own record the way saving conversations
 * is (src/record/conversations.ts), so one folder can stay on this computer while another uses the
 * cloud, and the choice travels with the folder.
 *
 * Absent means this computer and the default local model. The cloud is never a default: it is stored
 * only after the person confirmed it for this folder.
 */
import type { Record as OpenRecord } from "./db.js";
import { checkChoice, type ModelChoice } from "../harness/choose.js";

const SETTING = "answer_model";

export function modelChoice(rec: OpenRecord, defaultLocal: string): ModelChoice {
  const raw = rec.db.prepare<[string], { value: string }>("SELECT value FROM meta WHERE key = ?").get(SETTING)?.value;
  if (raw) {
    try {
      const c = JSON.parse(raw) as ModelChoice;
      if (!checkChoice(c)) return { where: c.where, model: c.model, zdr: c.zdr !== false };
    } catch {
      /* an unreadable setting is no setting: this computer, which sends nothing */
    }
  }
  return { where: "local", model: defaultLocal, zdr: true };
}

export function setModelChoice(rec: OpenRecord, c: ModelChoice): ModelChoice {
  const wrong = checkChoice(c);
  if (wrong) throw new Error(wrong);
  const clean: ModelChoice = { where: c.where, model: c.model, zdr: c.zdr !== false };
  rec.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(SETTING, JSON.stringify(clean));
  return clean;
}
