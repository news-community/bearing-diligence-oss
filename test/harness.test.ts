import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ask, toolsOffered, CHARS_PER_TOKEN } from "../src/harness/model.js";
import { identify, isUp, RUNTIME_ORIGIN } from "../src/harness/runtime.js";

/** Replace fetch for one call, so each failure kind can be produced deliberately. */
async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("the endpoint is loopback and there is no way to point it elsewhere", () => {
  assert.match(RUNTIME_ORIGIN, /^http:\/\/127\.0\.0\.1:1948$/);
});

test("no tools are offered, in either mode", () => {
  assert.deepEqual(toolsOffered("ingestion"), []);
  assert.deepEqual(toolsOffered("question"), []);
});

test("returning nothing is its own result, not a null", async () => {
  const r = await withFetch(async () => json({ response: "   ", prompt_eval_count: 100 }), () =>
    ask({ model: "m", prompt: "x".repeat(360) }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.failure.kind, "empty");
});

test("a model that will not load is its own result", async () => {
  const r = await withFetch(async () => new Response("model 'x' not found, try pulling the model", { status: 404 }), () =>
    ask({ model: "x", prompt: "hello" }),
  );
  assert.equal(r.ok === false && r.failure.kind, "no_model");
});

test("running out of memory is its own result", async () => {
  const r = await withFetch(async () => new Response("failed to allocate memory: model too large", { status: 500 }), () =>
    ask({ model: "m", prompt: "hello" }),
  );
  assert.equal(r.ok === false && r.failure.kind, "out_of_memory");
});

test("a prompt the runtime shortened is its own result, and says what was dropped", async () => {
  const prompt = "x".repeat(40_000);
  const estimated = Math.ceil(prompt.length / CHARS_PER_TOKEN);
  const r = await withFetch(async () => json({ response: "fine", prompt_eval_count: 2048 }), () =>
    ask({ model: "m", prompt }),
  );
  assert.equal(r.ok, false);
  if (r.ok === false && r.failure.kind === "truncated") {
    assert.equal(r.failure.estimated_tokens, estimated);
    assert.match(r.failure.detail, /what was dropped is the beginning/);
  } else {
    assert.fail(`expected truncated, got ${JSON.stringify(r)}`);
  }
});

test("a prompt that fits is not called truncated", async () => {
  const prompt = "x".repeat(3600);
  const r = await withFetch(async () => json({ response: "fine", prompt_eval_count: 1000 }), () =>
    ask({ model: "m", prompt }),
  );
  assert.equal(r.ok, true, "1000 evaluated against an estimated 1000 is not truncation");
});

test("an unreachable runtime is its own result and names the address", async () => {
  const r = await withFetch(async () => {
    throw new Error("connect ECONNREFUSED");
  }, () => ask({ model: "m", prompt: "hello" }));
  assert.equal(r.ok === false && r.failure.kind, "unreachable");
  assert.ok(r.ok === false && r.failure.detail.includes("127.0.0.1:1948"));
});

test("structured output that does not parse fails rather than being passed on", async () => {
  const r = await withFetch(async () => json({ response: "{not json", prompt_eval_count: 10 }), () =>
    ask({ model: "m", prompt: "x".repeat(36), format: { type: "object" } }),
  );
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.failure.detail : "", /did not parse/);
});

test("something answering on the port is not the same as the runtime answering", async () => {
  const notTheRuntime = async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/api/version")) return json({ hello: "I am a different program" });
    return json({ models: [] });
  };
  const who = await withFetch(notTheRuntime as typeof fetch, () => identify(500));
  assert.equal(who.answering, true);
  assert.equal(who.answering && who.speaks_the_protocol, false, "a responder that cannot name a version is not the runtime");
  const up = await withFetch(notTheRuntime as typeof fetch, () => isUp(500));
  assert.equal(up, false, "and isUp must say so rather than counting it as ready");
});

test("the real runtime identifies itself by version and by what it holds", async () => {
  const who = await withFetch(
    (async (url: string | URL | Request) =>
      String(url).endsWith("/api/version")
        ? json({ version: "0.32.1" })
        : json({ models: [{ name: "gemma3:4b" }] })) as typeof fetch,
    () => identify(500),
  );
  assert.equal(who.answering && who.speaks_the_protocol, true);
  if (who.answering) {
    assert.equal(who.version, "0.32.1");
    assert.deepEqual(who.models, ["gemma3:4b"]);
  }
});

// Local models that think, and one that cannot honour a schema, measured 2026-09-30. A stand-in
// runtime answers each request in turn and records what was sent.
import { ask as askLocal, contextFor, thinkFor } from "../src/harness/model.js";
/** `thinks` lists the models the stand-in runtime reports as able to think (its /api/show capabilities). */
async function withRuntime(replies: Array<Record<string, unknown>>, run: (sent: any[]) => Promise<void>, thinks: string[] = []) {
  const real = globalThis.fetch, sent: any[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (String(url).endsWith("/api/show")) {
      return new Response(JSON.stringify({ capabilities: thinks.includes(body.model) ? ["completion", "thinking"] : ["completion"] }), { status: 200 });
    }
    sent.push(body);
    return new Response(JSON.stringify({ done: true, done_reason: "stop", prompt_eval_count: 0, eval_count: 5, ...replies.shift() }), { status: 200 });
  }) as unknown as typeof fetch;
  try { await run(sent); } finally { globalThis.fetch = real; }
}
const SCHEMA_OK = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };

test("a model that can think does, and one that cannot is told false", () => {
  assert.equal(thinkFor("gemma3:27b", false), false);
  assert.equal(thinkFor("qwen3.5:9b", true), true);
  assert.equal(thinkFor("gpt-oss:120b", true), "medium", "gpt-oss takes a level");
});

test("a thinking model reasons first, with the schema in the prompt and room to think, and its answer is checked as before", async () => {
  await withRuntime([{ response: '```json\n{ "ok": true }\n```', thinking: "Let me work this out." }], async (sent) => {
    const r = await askLocal({ model: "qwen3.5:9b-thinks", prompt: "Q", format: SCHEMA_OK, maxTokens: 2048 });
    assert.ok(r.ok && (r.value as any).ok === true);
    assert.equal(sent[0].think, true);
    assert.equal(sent[0].format, undefined, "the runtime mishandles a schema and thinking together");
    assert.match(sent[0].prompt, /reply with only a JSON object matching this schema/);
    assert.equal(sent[0].options.num_predict, 8192, "the answer's cap plus room to reason");
  }, ["qwen3.5:9b-thinks"]);
  await withRuntime([{ response: "I think the board met." }], async () => {
    const r = await askLocal({ model: "qwen3.5:9b-thinks2", prompt: "Q", format: SCHEMA_OK });
    assert.ok(!r.ok && /did not parse/.test(r.failure.detail), "the control: prose instead of the JSON asked for is refused");
  }, ["qwen3.5:9b-thinks2"]);
});

test("a structured answer a thinking model put in its thinking field is still the answer", async () => {
  await withRuntime([{ response: "", thinking: '{ "ok": true }' }], async (sent) => {
    const r = await askLocal({ model: "qwen3.5:4b", prompt: "Q", format: SCHEMA_OK });
    assert.ok(r.ok && (r.value as any).ok === true);
    assert.equal(sent[0].think, false);
  });
});

test("a schema a model returns nothing for is retried once on the same model with the schema in the prompt", async () => {
  await withRuntime([{ response: "", thinking: "" }, { response: '```json\n{ "ok": true }\n```' }], async (sent) => {
    const r = await askLocal({ model: "gpt-oss:120b", prompt: "Q", format: SCHEMA_OK });
    assert.ok(r.ok && (r.value as any).ok === true, "a fenced JSON reply parses");
    assert.equal(sent.length, 2);
    assert.equal(sent[1].model, "gpt-oss:120b", "the same model, never another");
    assert.equal(sent[1].format, undefined);
    assert.match(sent[1].prompt, /Reply with only a JSON object matching this schema/);
  });
  await withRuntime([{ response: "" }, { response: "The board meets monthly." }], async () => {
    const r = await askLocal({ model: "gpt-oss:120b", prompt: "Q", format: SCHEMA_OK });
    assert.ok(!r.ok && /did not parse/.test(r.failure.detail), "the control: a reply that is not the JSON asked for is refused");
  });
});

test("a reply cap is sent to the runtime, and a reply stopped at it is a cut-off, not a parse failure", async () => {
  await withRuntime([{ response: '{ "ok": tr', done_reason: "length" }], async (sent) => {
    const r = await askLocal({ model: "qwen3:8b", prompt: "Q", format: SCHEMA_OK, maxTokens: 2048 });
    assert.equal(sent[0].options.num_predict, 2048);
    assert.ok(!r.ok && r.failure.kind === "cut_off");
  });
});

test("reasoning written into the answer and closed with </think> is not the answer; what follows is", async () => {
  await withRuntime([{ response: 'Okay, let me see. {"draft": 1}\n</think>\n{ "ok": true }' }], async () => {
    const r = await askLocal({ model: "granite-like", prompt: "Q", format: SCHEMA_OK });
    assert.ok(r.ok && (r.value as any).ok === true);
  });
  await withRuntime([{ response: "Okay, let me see.\n</think>\nThe board met." }], async () => {
    const r = await askLocal({ model: "granite-like2", prompt: "Q", format: SCHEMA_OK });
    assert.ok(!r.ok && /did not parse/.test(r.failure.detail), "the control: prose after the tag is still refused");
  });
});

test("the context window is sized to the request, not left at the model's maximum", async () => {
  assert.equal(contextFor({ prompt: "x".repeat(100), maxTokens: 2048 }), 8192);
  assert.equal(contextFor({ prompt: "x".repeat(40_000), maxTokens: 8192 }), 32768, "sixteen passages and room to reason");
  await withRuntime([{ response: '{ "ok": true }' }], async (sent) => {
    await askLocal({ model: "sized", prompt: "Q", format: SCHEMA_OK, maxTokens: 2048 });
    assert.equal(sent[0].options.num_ctx, 8192, "always sent, so the runtime never reserves its maximum");
  });
});
