/**
 * The only place in this application that speaks to a model, and it speaks to one address.
 *
 * Three rules live here.
 *
 * Invariant 1: the endpoint is pinned to loopback IN CODE. There is no setting, no environment
 * variable and no default to override, because in two of the three sibling prototypes the endpoint
 * was overridable and in one the off-machine warning read a different variable from the one the
 * client used, so its own documented remote setup warned nobody.
 *
 * Invariant 10: no tools, in either mode. The ingestion list is empty and the question list is
 * empty, and `toolsOffered()` exists so a test can read what was actually offered rather than what
 * the configuration says.
 *
 * Gate rule 2: a failure says why. "Returned nothing", "would not load", "out of memory" and
 * "prompt truncated" are four different results and never one null.
 */
import { RUNTIME_ORIGIN } from "./runtime.js";

export type Failure =
  | { kind: "unreachable"; detail: string }
  | { kind: "no_model"; detail: string }
  | { kind: "out_of_memory"; detail: string }
  | { kind: "empty"; detail: string }
  | { kind: "truncated"; detail: string; chars_sent: number; prompt_eval_count: number; estimated_tokens: number }
  /** The REPLY was cut off at its length limit: its last sentences, and a structured reply's closing brace, are missing. */
  | { kind: "cut_off"; detail: string }
  /** A hosted service declined the request: no key, a rejected key, no credit, or a model it will not serve that way. */
  | { kind: "refused_by_service"; detail: string };

export type Usage = { prompt_eval_count: number; eval_count: number; total_duration_ms: number };
/** `served_by` is the company that ran a hosted model for this call, which a hosted router chooses per call. */
export type Ask<T> = { ok: true; value: T; raw: string; usage: Usage; served_by?: string } | { ok: false; failure: Failure };

/**
 * The end of every model call, local or hosted, in one place: an empty reply and a structured reply
 * that does not parse fail the same way whichever client produced them (src/harness/choose.ts).
 */
export function settle<T>(text: string, format: unknown, usage: Usage, served_by?: string): Ask<T> {
  // A model answering without a schema often fences its JSON ("```json ... ```"); the fence is not
  // the answer, and removing it changes nothing a parse would accept or refuse.
  // A model that reasons inside its answer closes the reasoning with </think> and then answers
  // (granite4.2, measured 2026-09-30); the answer is what follows the last one.
  const afterThinking = text.includes("</think>") ? text.slice(text.lastIndexOf("</think>") + "</think>".length) : text;
  const t = format ? afterThinking.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1").trim() : afterThinking.trim();
  if (!t) return { ok: false, failure: { kind: "empty", detail: "the model returned nothing, which is not the same as finding nothing" } };
  if (!format) return { ok: true, value: t as unknown as T, raw: t, usage, served_by };
  try {
    return { ok: true, value: JSON.parse(t) as T, raw: t, usage, served_by };
  } catch (e) {
    return { ok: false, failure: { kind: "empty", detail: `structured output did not parse: ${(e as Error).message}` } };
  }
}

/**
 * The general model, named once. It was written seven times in six files until 2026-09-28, the
 * shape `EMBED_MODEL` in src/answer/embed.ts already avoided.
 *
 * It is the SMALLEST pinned model and it reads every document. Which model ANSWERS is chosen per
 * folder, by measurement (docs/models.md), so this one is a constant and never a setting.
 */
export const GENERAL_MODEL = "gemma3:4b";

/** Both lists are empty, in both modes. A test reads this rather than the configuration. */
export function toolsOffered(_mode: "ingestion" | "question"): string[] {
  return [];
}

/**
 * Tokens are estimated from characters because the runtime exposes no tokenizer, so this is a
 * CALIBRATE value: 3.6 characters per token is a working assumption for English prose and is wrong
 * for tables and for identifiers. It is used only to decide whether the runtime silently shortened
 * the prompt, never to size a window.
 */
export const CHARS_PER_TOKEN = 3.6;
const TRUNCATION_MARGIN = 0.8;

/**
 * How a model thinks when it can. A research question is the reason to ask at all, so a model that
 * can reason does (2026-09-30: a model that cannot reason well within sensible limits is not
 * one to recommend). gpt-oss takes a level rather than on or off; others take true. A model without
 * the capability gets `false`, which it accepts unchanged.
 */
export function thinkFor(model: string, canThink: boolean): boolean | "medium" {
  if (!canThink) return false;
  return /^gpt-oss/.test(model) ? "medium" : true;
}

/** Which models can think, read from the runtime's own model capabilities and kept for the session. */
const thinking = new Map<string, boolean>();
export async function canThink(model: string): Promise<boolean> {
  if (!thinking.has(model)) {
    try {
      const res = await fetch(`${RUNTIME_ORIGIN}/api/show`, { method: "POST", body: JSON.stringify({ model }) });
      const json = (await res.json()) as { capabilities?: string[] };
      thinking.set(model, (json.capabilities ?? []).includes("thinking"));
    } catch {
      return false; // unknown: the schema path, which every model can take
    }
  }
  return thinking.get(model)!;
}

/**
 * The context window a request needs, from a fixed set of sizes. Left unset, the runtime reserved
 * each model's MAXIMUM (262,144 tokens for gemma4), and the working memory that comes with it made an
 * 8B model take 27.7 GB and qwen3:30b 44.8 GB, which looked like a 32 GB minimum and was a setting
 * (2026-10-01). A request needs its prompt, its reply and its reasoning; fixed sizes keep the runtime
 * from reloading a model whenever a prompt is a little longer. The truncation check still refuses a
 * prompt the runtime shortened.
 */
const CONTEXT_SIZES = [8192, 16384, 32768, 65536, 131072];
export function contextFor(opts: { prompt: string; system?: string; maxTokens?: number }): number {
  const need = Math.ceil(((opts.prompt.length + (opts.system?.length ?? 0)) / CHARS_PER_TOKEN) * 1.1) + (opts.maxTokens ?? 2048);
  return CONTEXT_SIZES.find((n) => n >= need) ?? CONTEXT_SIZES[CONTEXT_SIZES.length - 1]!;
}

/** Room for reasoning on top of the answer's own cap, when a model thinks. CALIBRATE: an estimate. */
export const THINKING_HEADROOM = 4;

export async function ask<T = unknown>(opts: {
  model: string;
  prompt: string;
  system?: string;
  format?: unknown;
  num_ctx?: number;
  timeoutMs?: number;
  /** The longest reply allowed, so a model that loops under a schema fails in seconds as cut off. */
  maxTokens?: number;
}): Promise<Ask<T>> {
  // A model that can think reasons first, and is asked for the JSON in the prompt rather than by a
  // schema: with thinking and a schema together the runtime put the whole answer in its thinking
  // field and left the answer empty (qwen3.5, measured 2026-09-30). The reply is parsed and checked
  // exactly as a schema-constrained one is.
  if (opts.format && (await canThink(opts.model))) {
    return askOnce<T>({
      ...opts,
      format: undefined,
      prompt: `${opts.prompt}\n\nWhen you have worked it out, reply with only a JSON object matching this schema, and nothing else:\n${JSON.stringify(opts.format)}`,
      parseAs: opts.format,
      think: thinkFor(opts.model, true),
      maxTokens: opts.maxTokens ? opts.maxTokens * THINKING_HEADROOM : undefined,
    });
  }
  const first = await askOnce<T>(opts);
  // A schema this model cannot honour came back as nothing at all: gpt-oss returned an empty answer
  // and empty thinking for every schema, in every thinking mode, while answering normally without one
  // (measured 2026-09-30). One retry on the SAME model with the schema written into the prompt; the
  // parse still refuses anything that is not the JSON asked for. Never another model (invariant 5).
  if (!first.ok && first.failure.kind === "empty" && opts.format && /returned nothing/.test(first.failure.detail)) {
    return askOnce<T>({
      ...opts,
      format: undefined,
      prompt: `${opts.prompt}\n\nReply with only a JSON object matching this schema, and nothing else:\n${JSON.stringify(opts.format)}`,
      parseAs: opts.format,
    });
  }
  return first;
}

async function askOnce<T>(opts: {
  model: string;
  prompt: string;
  system?: string;
  format?: unknown;
  num_ctx?: number;
  timeoutMs?: number;
  maxTokens?: number;
  /** Parse the reply as structured output although no schema was sent (the retry above). */
  parseAs?: unknown;
  think?: boolean | "medium";
}): Promise<Ask<T>> {
  const body: Record<string, unknown> = {
    model: opts.model,
    prompt: opts.prompt,
    stream: false,
    think: opts.think ?? false,
    options: { temperature: 0, num_ctx: opts.num_ctx ?? contextFor(opts), ...(opts.maxTokens ? { num_predict: opts.maxTokens } : {}) },
  };
  if (opts.system) body["system"] = opts.system;
  if (opts.format) body["format"] = opts.format;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 600_000);
  let res: Response;
  let raw: string;
  // The whole reply is read inside the time limit, not only its start (see src/cloud/openrouter.ts:
  // a limit on the start alone let one hosted answer run 47 minutes against five).
  try {
    res = await fetch(`${RUNTIME_ORIGIN}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    raw = await res.text();
  } catch (e) {
    const detail = ac.signal.aborted ? `no complete answer within ${Math.round((opts.timeoutMs ?? 600_000) / 1000)} s` : (e as Error).message;
    return { ok: false, failure: { kind: "unreachable", detail: `${RUNTIME_ORIGIN}: ${detail}` } };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = raw;
    const low = text.toLowerCase();
    if (low.includes("not found") || low.includes("no such model") || low.includes("pull the model")) {
      return { ok: false, failure: { kind: "no_model", detail: text.slice(0, 300) } };
    }
    if (low.includes("memory") || low.includes("oom") || low.includes("too large")) {
      return { ok: false, failure: { kind: "out_of_memory", detail: text.slice(0, 300) } };
    }
    return { ok: false, failure: { kind: "unreachable", detail: `HTTP ${res.status}: ${text.slice(0, 300)}` } };
  }

  // A 200 with an HTML body, a truncated body or a reset mid-body used to REJECT out of this
  // function, which is the one thing its header says it never does: a failure says why, and never
  // by throwing at a caller that expected a result.
  let json: {
    response?: string;
    prompt_eval_count?: number;
    eval_count?: number;
    total_duration?: number;
    done_reason?: string;
    thinking?: string;
    error?: string;
  };
  try {
    json = JSON.parse(raw) as typeof json;
  } catch (e) {
    return {
      ok: false,
      failure: { kind: "unreachable", detail: `the runtime answered with something that is not JSON: ${(e as Error).message}` },
    };
  }
  if (json.error) {
    const low = json.error.toLowerCase();
    const kind = low.includes("memory") ? "out_of_memory" : low.includes("model") ? "no_model" : "unreachable";
    return { ok: false, failure: { kind, detail: json.error.slice(0, 300) } as Failure };
  }

  const usage: Usage = {
    prompt_eval_count: json.prompt_eval_count ?? 0,
    eval_count: json.eval_count ?? 0,
    total_duration_ms: Math.round((json.total_duration ?? 0) / 1e6),
  };

  // The runtime keeps the END of an over-long prompt and says so only in its own log, so a window
  // that was silently shortened looks exactly like one the model read.
  const estimated = Math.ceil(opts.prompt.length / CHARS_PER_TOKEN);
  if (usage.prompt_eval_count > 0 && usage.prompt_eval_count < estimated * TRUNCATION_MARGIN) {
    return {
      ok: false,
      failure: {
        kind: "truncated",
        detail:
          `the runtime evaluated ${usage.prompt_eval_count} prompt tokens for a prompt estimated at ` +
          `${estimated}. The window was shortened, and what was dropped is the beginning.`,
        chars_sent: opts.prompt.length,
        prompt_eval_count: usage.prompt_eval_count,
        estimated_tokens: estimated,
      },
    };
  }

  // A reply stopped at its length limit is missing its end, which for a structured reply is the part
  // that makes it parse; said as what it is rather than as a parse failure.
  if (json.done_reason === "length") {
    return { ok: false, failure: { kind: "cut_off", detail: `the reply stopped at its length limit after ${usage.eval_count} tokens` } };
  }
  // A thinking model that ignored `think: false` may still have put the answer in `thinking`.
  const reply = json.response?.trim() ? json.response : (opts.format || opts.parseAs) && json.thinking?.trim().startsWith("{") ? json.thinking : json.response;
  return settle<T>(reply ?? "", opts.format ?? opts.parseAs, usage);
}

/**
 * Embedding vectors, through the same pinned endpoint as everything else.
 *
 * This lives here and not beside the retrieval code because `model.ts` claims to be the only place
 * in this application that speaks to a model, and that claim has to stay true. It was briefly false:
 * the embedding layer called the runtime directly, and the forbidden-reference gate caught it.
 */
export async function embedTexts(
  texts: string[],
  model: string,
  timeoutMs = 120_000,
): Promise<{ ok: true; vectors: number[][] } | { ok: false; failure: Failure }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${RUNTIME_ORIGIN}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: texts }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      const kind = /not found|no such model/i.test(text) ? "no_model" : "unreachable";
      return { ok: false, failure: { kind, detail: text.slice(0, 300) } as Failure };
    }
    const body = (await res.json().catch(() => ({}))) as { embeddings?: number[][] };
    if (!body.embeddings?.length) {
      return {
        ok: false,
        failure: { kind: "empty", detail: "the embedding model returned nothing, which is not the same as finding nothing" },
      };
    }
    return { ok: true, vectors: body.embeddings };
  } catch (e) {
    return { ok: false, failure: { kind: "unreachable", detail: `${RUNTIME_ORIGIN}: ${(e as Error).message}` } };
  } finally {
    clearTimeout(timer);
  }
}
