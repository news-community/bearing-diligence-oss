import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ask } from "../src/harness/model.js";
import { isUp, RUNTIME_ORIGIN } from "../src/harness/runtime.js";

/**
 * Against the runtime actually listening on 1948. These are the checks that cannot be stubbed: a
 * stub cannot tell you the real server answers the way the client assumes.
 */
const up = await isUp(2000);

test("invariant 5: a task whose model is missing REFUSES and does not reach anywhere else", { skip: !up ? `nothing is listening on ${RUNTIME_ORIGIN}` : false }, async () => {
  const r = await ask({ model: "a-model-that-was-never-pulled:0b", prompt: "say hello", timeoutMs: 20000 });
  assert.equal(r.ok, false);
  assert.ok(
    r.ok === false && (r.failure.kind === "no_model" || r.failure.kind === "unreachable"),
    `expected a refusal naming the missing model, got ${JSON.stringify(r)}`,
  );
});

test("the real runtime answers the client's assumptions", { skip: !up ? "runtime down" : false }, async () => {
  const r = await ask<string>({ model: "gemma3:4b", prompt: "Reply with the single word: ready", timeoutMs: 120000 });
  assert.equal(r.ok, true, `the runtime should answer: ${JSON.stringify(r)}`);
  if (r.ok) {
    assert.ok(r.usage.prompt_eval_count > 0, "prompt_eval_count is what truncation detection reads");
    assert.ok(r.usage.eval_count > 0);
  }
});

test("structured output comes back as an object", { skip: !up ? "runtime down" : false }, async () => {
  const r = await ask<{ colour: string }>({
    model: "gemma3:4b",
    prompt: 'Return JSON with one key "colour" whose value is the word blue.',
    format: { type: "object", properties: { colour: { type: "string" } }, required: ["colour"] },
    timeoutMs: 120000,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (r.ok) assert.equal(typeof r.value.colour, "string");
});
