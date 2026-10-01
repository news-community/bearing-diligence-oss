/**
 * Which model answers: chosen once, here, and invisible to the code that asks.
 *
 * A folder answers either on this computer (the harness, pinned to loopback) or, when its owner has
 * chosen it, through the one hosted path (src/cloud/openrouter.ts). The answer path receives an
 * `Asker` and never learns which it has, so the receipt, date, name and outcome checks run the same
 * on both. This is the only file allowed to import the cloud module (the "cloud isolated" gate).
 *
 * No fallback, in either direction (invariant 5): a cloud failure is returned as a cloud failure and
 * a local failure as a local one. Nothing here retries on the other side.
 */
import { ask, type Ask } from "./model.js";
import { askCloud, CLOUD, listCloudModels, type CloudModel } from "../cloud/openrouter.js";

/** The cloud destination and its model list, reached through here so nothing else imports the cloud module. */
export { CLOUD, listCloudModels, type CloudModel };

export type ModelChoice = {
  where: "local" | "cloud";
  model: string;
  zdr?: boolean;
  /** For comparing a hosted copy of a local model on equal terms (tools/compare-models.mjs). Not a setting. */
  reasoning?: "off";
};
export type Asker = <T = unknown>(opts: { model: string; prompt: string; system?: string; format?: unknown; num_ctx?: number; timeoutMs?: number; maxTokens?: number }) => Promise<Ask<T>>;

/**
 * A choice that cannot be right is refused with the reason, rather than sent and answered with a
 * confusing failure: a local name carries a size tag (`gemma3:4b`) and a hosted one names its maker
 * (`provider/model`).
 */
export function checkChoice(c: ModelChoice): string | null {
  if (c.where !== "local" && c.where !== "cloud") return `"${String(c.where)}" is neither this computer nor the cloud`;
  if (!c.model) return "no model is chosen";
  if (c.where === "local" && c.model.includes("/")) {
    return `"${c.model}" is a hosted model's name (maker/model); a model on this computer is named like gemma3:4b`;
  }
  if (c.where === "cloud" && !c.model.includes("/")) {
    return `"${c.model}" is named like a model on this computer; a hosted model is named maker/model, as OpenRouter lists it`;
  }
  return null;
}

/** The asker for a choice. The key is read by the caller from where it is kept and passed in; nothing here stores it. */
export function askerFor(c: ModelChoice, opts: { cloudKey?: string } = {}): Asker {
  const wrong = checkChoice(c);
  if (wrong) {
    return async () => ({ ok: false, failure: { kind: "refused_by_service", detail: wrong } });
  }
  if (c.where === "local") return (o) => ask({ ...o, model: c.model });
  return (o) => askCloud({ ...o, model: c.model, key: opts.cloudKey ?? "", zdr: c.zdr, reasoning: c.reasoning });
}
