/**
 * The hosted path, against a stand-in transport so no key and no network are needed: what it sends,
 * where the key goes, how each failure is named, and that a choice that cannot be right is refused.
 * Plus the per-folder choice and the memory rule that picks the default local model.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askCloud, CLOUD, forgetModelParams } from "../src/cloud/openrouter.js";
import { askerFor, checkChoice } from "../src/harness/choose.js";
import { confirmLocation, openRecord } from "../src/record/db.js";
import { modelChoice, setModelChoice } from "../src/record/model-choice.js";
import { bestLocal, fitsMemory, needsOf } from "../src/ui/models.js";

type Sent = { url: string; headers: Record<string, string>; body: any };
/** Answers the public model list (who accepts temperature) and records every chat request. */
const MODELS = { data: [{ id: "maker/model", supported_parameters: ["temperature", "structured_outputs"] }, { id: "openai/no-temp", supported_parameters: ["structured_outputs"] }] };
const stub = (status: number, json: unknown, sent: Sent[] = []) =>
  (async (url: string, init?: RequestInit) => {
    if (url.includes("/models")) return new Response(JSON.stringify(MODELS), { status: 200 });
    sent.push({ url, headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) });
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

const SCHEMA = { type: "object", properties: { sentences: { type: "array" } }, required: ["sentences"], additionalProperties: false };
const reply = (content: string, finish = "stop") => ({ choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5 }, provider: "Example Host" });

test("a cloud answer asks for the strict schema, no data collection, zero retention, and names who served it", async () => {
  forgetModelParams();
  const sent: Sent[] = [];
  const r = await askCloud({ model: "maker/model", prompt: "Q", system: "S", format: SCHEMA, key: "k-test", transport: stub(200, reply('{"sentences":[]}'), sent) });
  assert.ok(r.ok && r.served_by === "Example Host");
  const s = sent[0]!;
  assert.equal(s.url, `${CLOUD.origin}/api/v1/chat/completions`, "the key goes to one fixed address");
  assert.equal(s.headers.authorization, "Bearer k-test");
  // Not require_parameters: measured 2026-09-30, it excluded every host for five of six strong models.
  assert.deepEqual(s.body.provider, { data_collection: "deny", zdr: true });
  assert.equal(s.body.response_format.json_schema.strict, true);
  assert.equal(s.body.temperature, 0);
  assert.deepEqual(s.body.messages.map((m: any) => m.role), ["system", "user"]);
});

test("temperature goes only to a model that accepts it", async () => {
  forgetModelParams();
  const sent: Sent[] = [];
  await askCloud({ model: "openai/no-temp", prompt: "Q", key: "k", transport: stub(200, reply("x"), sent) });
  assert.equal("temperature" in sent[0]!.body, false, "OpenAI's GPT-6 models refuse the parameter");
});

test("no host meeting the privacy settings is said as that, not as a missing model", async () => {
  const r = await askCloud({ model: "maker/model", prompt: "Q", key: "k", transport: stub(404, { error: { message: "No endpoints found that can handle the requested parameters." } }) });
  assert.ok(!r.ok && r.failure.kind === "refused_by_service" && /privacy settings/.test(r.failure.detail));
});

test("zero data retention is on unless the person turns it off", async () => {
  const sent: Sent[] = [];
  await askCloud({ model: "maker/model", prompt: "Q", key: "k", zdr: false, transport: stub(200, reply("text"), sent) });
  assert.equal(sent[0]!.body.provider.zdr, false);
});

test("each failure is named: no key sends nothing, a cut-off reply, a rejected key, no credit, an unknown model", async () => {
  const sent: Sent[] = [];
  const none = await askCloud({ model: "maker/model", prompt: "Q", key: "", transport: stub(200, reply("x"), sent) });
  assert.ok(!none.ok && none.failure.kind === "refused_by_service");
  assert.equal(sent.length, 0, "without a key nothing is sent at all");
  const cut = await askCloud({ model: "m/x", prompt: "Q", format: SCHEMA, key: "k", transport: stub(200, reply('{"sentences":[', "length")) });
  assert.ok(!cut.ok && cut.failure.kind === "cut_off", "a reply stopped at its length limit is not a parse failure");
  for (const [status, kind] of [[401, "refused_by_service"], [402, "refused_by_service"], [404, "no_model"], [503, "unreachable"]] as const) {
    const r = await askCloud({ model: "m/x", prompt: "Q", key: "k", transport: stub(status, { error: { message: "no" } }) });
    assert.ok(!r.ok && r.failure.kind === kind, `HTTP ${status} is ${kind}`);
  }
  const bad = await askCloud({ model: "m/x", prompt: "Q", format: SCHEMA, key: "k", transport: stub(200, reply("not json")) });
  assert.ok(!bad.ok && /did not parse/.test(bad.failure.detail), "a structured answer that does not parse is refused, as it is locally");
});

test("a choice that cannot be right is refused with the reason, and never sent", async () => {
  assert.match(checkChoice({ where: "cloud", model: "gemma3:4b" })!, /named like a model on this computer/);
  assert.match(checkChoice({ where: "local", model: "maker/model" })!, /hosted model's name/);
  assert.equal(checkChoice({ where: "local", model: "gemma3:4b" }), null);
  const r = await askerFor({ where: "cloud", model: "gemma3:4b" })({ model: "", prompt: "Q" });
  assert.ok(!r.ok && r.failure.kind === "refused_by_service");
});

test("the choice belongs to the folder: absent is this computer, and the cloud is only what was set", () => {
  const dirs = [mkdtempSync(join(tmpdir(), "pr-model-a-")), mkdtempSync(join(tmpdir(), "pr-model-b-"))];
  for (const d of dirs) confirmLocation(d, "the test");
  const [a, b] = dirs.map((d) => openRecord(d));
  assert.deepEqual(modelChoice(a!, "gemma3:27b"), { where: "local", model: "gemma3:27b", zdr: true }, "no setting is this computer");
  setModelChoice(a!, { where: "cloud", model: "maker/model", zdr: true });
  assert.equal(modelChoice(a!, "gemma3:27b").where, "cloud");
  assert.equal(modelChoice(b!, "gemma3:27b").where, "local", "another folder is not changed");
  assert.throws(() => setModelChoice(a!, { where: "cloud", model: "gemma3:4b" }), /named like a model on this computer/);
  a!.db.prepare("UPDATE meta SET value = 'not json' WHERE key = 'answer_model'").run();
  assert.equal(modelChoice(a!, "gemma3:4b").where, "local", "an unreadable setting is this computer, which sends nothing");
  a!.db.close(); b!.db.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("the default local model is the best measured one that fits memory, not the largest", () => {
  const GB = 1e9;
  assert.equal(fitsMemory(needsOf(18.6 * GB, 44.8), 128 * GB), true);
  assert.equal(fitsMemory(needsOf(18.6 * GB, 44.8), 32 * GB), false, "measured memory, larger than the file-size estimate, decides");
  const m = (name: string, recall: number | undefined, extra: Record<string, unknown> = {}) =>
    ({ name, size: 10 * GB, needs: 10 * GB, held: true, matches: true, fits: true, research_recall: recall, median_seconds: 40, ranked: true, ...extra });
  assert.equal(bestLocal([m("gemma3:27b", 38), m("qwen3:30b", 68)]), "qwen3:30b", "the larger is not the better");
  assert.equal(bestLocal([m("qwen3:30b", 68, { fits: false }), m("gemma4:26b", 60)]), "gemma4:26b", "the best that fits");
  assert.equal(bestLocal([m("gemma4:12b", 64, { ranked: false }), m("gemma4:26b", 60)]), "gemma4:26b", "an unranked model is never the default");
  assert.equal(bestLocal([m("x", 60, { held: false })]), "gemma3:4b", "with nothing usable, the reading model");
  assert.equal(bestLocal([m("gemma4:31b", 75, { median_seconds: 202 }), m("qwen3:30b", 68, { median_seconds: 45 })]), "qwen3:30b",
    "the most thorough is offered, not chosen, when it is too slow to be the default");
  assert.equal(bestLocal([m("gemma4:31b", 75, { median_seconds: 202 })]), "gemma4:31b", "and is chosen when nothing faster fits");
  assert.ok(needsOf(20.4 * GB, 2.4) > 20 * GB, "an under-reported memory never shrinks what a model needs");
});

test("a hosted reply cap leaves room for reasoning, and reasoning off sends the plain cap", async () => {
  forgetModelParams();
  const sent: Sent[] = [];
  await askCloud({ model: "maker/model", prompt: "Q", key: "k", maxTokens: 2048, transport: stub(200, reply("x"), sent) });
  assert.equal(sent[0]!.body.max_tokens, 8192, "reasoning counts against max_tokens on OpenRouter");
  assert.equal("reasoning" in sent[0]!.body, false, "the model's own reasoning setting is left alone");
  await askCloud({ model: "maker/model", prompt: "Q", key: "k", maxTokens: 2048, reasoning: "off", transport: stub(200, reply("x"), sent) });
  assert.equal(sent[1]!.body.max_tokens, 2048);
  assert.deepEqual(sent[1]!.body.reasoning, { effort: "none" });
});

test("reasoning off is gpt-oss's lowest level, since it cannot reason at none", async () => {
  forgetModelParams();
  const sent: Sent[] = [];
  await askCloud({ model: "openai/gpt-oss-20b", prompt: "Q", key: "k", reasoning: "off", transport: stub(200, reply("x"), sent) });
  assert.deepEqual(sent[0]!.body.reasoning, { effort: "low" });
});

test("the time limit covers the whole reply, not only its start", async () => {
  // A host that starts its response at once and then holds the connection: the body never finishes.
  const slow = (async (url: string, init?: RequestInit) => {
    if (url.includes("/models")) return new Response(JSON.stringify(MODELS), { status: 200 });
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(" ")); init!.signal!.addEventListener("abort", () => c.error(new Error("aborted"))); } });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  const t0 = Date.now();
  const r = await askCloud({ model: "maker/model", prompt: "Q", key: "k", timeoutMs: 300, transport: slow });
  assert.ok(!r.ok && /no complete answer within/.test(r.failure.detail), r.ok ? "answered" : r.failure.detail);
  assert.ok(Date.now() - t0 < 3000, "and it stops at the limit");
});
