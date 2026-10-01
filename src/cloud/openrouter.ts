/**
 * The one hosted model path: OpenRouter, used only to ANSWER, and only in a folder whose owner chose
 * it (docs/design.md, "What leaves the machine").
 *
 * What this sends, and nothing else: the question, up to two earlier turns, and the passages
 * retrieved for it. Reading a document, the search index, embeddings and the change record never
 * reach this module, and a gate holds that (src/gates/gates.ts, "cloud isolated"): only the chooser
 * in src/harness/choose.ts may import it.
 *
 * Three rules from the plan live here:
 *   - The key is attached to one fixed address and there is no setting for another, so a typo cannot
 *     send it elsewhere.
 *   - The request asks OpenRouter to route only to hosts that do not collect data and, when the
 *     person leaves it on, that retain nothing. Those are the vendor's claims, not mechanisms anyone
 *     here can check, and the page says so. It does NOT require every host to honour the answer's
 *     schema: measured 2026-09-30, no host for five of six strong models offered both zero retention
 *     and a guaranteed schema, so one had to give, and privacy is the one a person chose. A reply
 *     that ignores the schema does not parse and is refused visibly, so nothing slips through.
 *   - Temperature 0 is sent only to a model that accepts it: OpenAI's GPT-6 models refuse the
 *     parameter, and asking a router to require it excluded every host they have.
 *   - A failure says why, in the harness's own terms (src/harness/model.ts), and is never retried
 *     on the local model.
 */
import { settle, type Ask, type Failure } from "../harness/model.js";

/** The cloud destination, described once. Every sentence the person reads about it takes its words from here. */
export const CLOUD = {
  label: "OpenRouter",
  thirdParty: true,
  origin: "https://openrouter.ai",
  /** What leaves, in the words the confirmation and the composer use. */
  sends: "your question, up to two earlier turns and the passages found for it",
  /**
   * The model the picker suggests, chosen by measurement rather than reputation: on six fixed
   * questions over public agendas, twice, after the answer checks stopped refusing true sentences, it
   * finished every question, kept 31 to 36 sentences a run at a 99% kept share, took a median 5.3 s,
   * and costs less per token than the next-best alternative
   * (docs/models.md).
   */
  suggested: "anthropic/claude-opus-5.5",
} as const;

const API = `${CLOUD.origin}/api/v1`;

export type CloudAskOpts = {
  model: string;
  prompt: string;
  system?: string;
  format?: unknown;
  timeoutMs?: number;
  maxTokens?: number;
  /**
   * "off" runs the model without reasoning, the way the local harness runs a thinking model; the
   * default leaves the model's own setting, which is how a person choosing a hosted model gets it.
   */
  reasoning?: "off";
  key: string;
  /** Route only to hosts that say they retain nothing. On unless the person turns it off. */
  zdr?: boolean;
  /** For tests: a transport standing in for the network. */
  transport?: typeof fetch;
};

export async function askCloud<T = unknown>(o: CloudAskOpts): Promise<Ask<T>> {
  if (!o.key) {
    return { ok: false, failure: { kind: "refused_by_service", detail: `no ${CLOUD.label} key is saved. Add one in Settings, under This folder.` } };
  }
  const body: Record<string, unknown> = {
    model: o.model,
    messages: [...(o.system ? [{ role: "system", content: o.system }] : []), { role: "user", content: o.prompt }],
    provider: { data_collection: "deny", zdr: o.zdr !== false },
    // OpenRouter counts reasoning against max_tokens, and a reasoning model that spends it returns an
    // empty answer cut off at the limit (its documentation, read 2026-09-30). So the cap on the visible
    // answer gets room for reasoning when reasoning is on. CALIBRATE: four times is an estimate.
    ...(o.maxTokens ? { max_tokens: o.reasoning === "off" ? o.maxTokens : o.maxTokens * 4 } : {}),
    // gpt-oss cannot reason at "none" (OpenRouter: "Reasoning is mandatory for this endpoint"), so off
    // is its lowest level, which is also how the local harness runs it (src/harness/model.ts, thinkFor).
    ...(o.reasoning === "off" ? { reasoning: { effort: /gpt-oss/.test(o.model) ? "low" : "none" } } : {}),
  };
  if (await acceptsTemperature(o.model, o.transport)) body["temperature"] = 0;
  if (o.format) body["response_format"] = { type: "json_schema", json_schema: { name: "answer", strict: true, schema: o.format } };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 180_000);
  let res: Response;
  let raw: string;
  // The whole reply is read inside the time limit, not only its start: OpenRouter starts a response at
  // once and holds the connection while the model works, so a limit on the start alone let one answer
  // run 47 minutes against a five-minute limit (qwen3.5-9b, 2026-09-30).
  const limitMs = o.timeoutMs ?? 180_000;
  try {
    res = await (o.transport ?? fetch)(`${API}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${o.key}` },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    raw = await res.text();
  } catch (e) {
    const detail = ac.signal.aborted ? `no complete answer within ${Math.round(limitMs / 1000)} s` : (e as Error).message;
    return { ok: false, failure: { kind: "unreachable", detail: `${CLOUD.label}: ${detail}` } };
  } finally {
    clearTimeout(timer);
  }

  let json: {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    provider?: string;
    error?: { message?: string; code?: number };
  };
  try {
    json = JSON.parse(raw) as typeof json;
  } catch (e) {
    return { ok: false, failure: { kind: "unreachable", detail: `${CLOUD.label} answered HTTP ${res.status} with something that is not JSON: ${(e as Error).message}` } };
  }
  if (!res.ok || json.error) {
    return { ok: false, failure: serviceFailure(res.status, json.error?.message ?? `HTTP ${res.status}`) };
  }
  const choice = json.choices?.[0];
  const usage = { prompt_eval_count: json.usage?.prompt_tokens ?? 0, eval_count: json.usage?.completion_tokens ?? 0, total_duration_ms: 0 };
  if (choice?.finish_reason === "length") {
    return { ok: false, failure: { kind: "cut_off", detail: `the reply stopped at its length limit after ${usage.eval_count} tokens` } };
  }
  return settle<T>(choice?.message?.content ?? "", o.format, usage, json.provider);
}

/** HTTP statuses in the harness's terms, so the page says what happened rather than a number. */
function serviceFailure(status: number, message: string): Failure {
  const detail = `${CLOUD.label}: ${message}`.slice(0, 300);
  // Not a missing model: every host that serves it was excluded by the routing this folder asked for.
  if (status === 404 && /no endpoints found/i.test(message)) {
    return {
      kind: "refused_by_service",
      detail: `No host for this model meets this folder's privacy settings (no data collection, zero data retention). ` +
        `Choose another model, or turn off "Only hosts that keep nothing" in Settings.`,
    };
  }
  if (status === 401 || status === 403) return { kind: "refused_by_service", detail: `${detail}. The saved key was not accepted.` };
  if (status === 402) return { kind: "refused_by_service", detail: `${detail}. The account has no credit left.` };
  if (status === 404) return { kind: "no_model", detail };
  if (status === 400) return { kind: "refused_by_service", detail };
  return { kind: "unreachable", detail };
}

/** Each model's accepted parameters, fetched once per session from the public list. */
let paramsById: Map<string, string[]> | null = null;
async function acceptsTemperature(model: string, transport?: typeof fetch): Promise<boolean> {
  if (!paramsById) {
    try {
      const res = await (transport ?? fetch)(`${API}/models?supported_parameters=structured_outputs`);
      const json = (await res.json()) as { data?: Array<{ id: string; supported_parameters?: string[] }> };
      paramsById = new Map((json.data ?? []).map((m) => [m.id, m.supported_parameters ?? []]));
    } catch {
      return false; // unknown: sending it risks a refusal, leaving it out risks only some variation
    }
  }
  return (paramsById.get(model) ?? []).includes("temperature");
}

/** For tests: forget the fetched parameter list. */
export function forgetModelParams(): void {
  paramsById = null;
}

export type CloudModel = { id: string; name: string; context: number; prompt_per_million: number; completion_per_million: number };

/**
 * The models OpenRouter lists that accept a structured answer, fetched when the picker opens. No key
 * is sent: the list is public. A model without structured outputs is left off, because answers are
 * requested against a schema and a model that ignores it is refused on every question.
 */
export async function listCloudModels(transport: typeof fetch = fetch): Promise<CloudModel[]> {
  const res = await transport(`${API}/models?supported_parameters=structured_outputs`);
  if (!res.ok) throw new Error(`${CLOUD.label} did not list its models: HTTP ${res.status}`);
  const json = (await res.json()) as {
    data?: Array<{ id: string; name?: string; context_length?: number; supported_parameters?: string[]; pricing?: { prompt?: string; completion?: string } }>;
  };
  return (json.data ?? [])
    .filter((m) => (m.supported_parameters ?? []).includes("structured_outputs"))
    .map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      context: m.context_length ?? 0,
      prompt_per_million: Number(m.pricing?.prompt ?? 0) * 1e6,
      completion_per_million: Number(m.pricing?.completion ?? 0) * 1e6,
    }));
}
