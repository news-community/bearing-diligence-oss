/**
 * The ONLY module in this application allowed to reach the network, and only at first run.
 *
 * It pulls the models named in a pinned manifest through the local runtime, verifies each against
 * the digest the manifest names, and refuses anything else. It never carries question text, never
 * carries document text, and is unreachable from ingestion or from question time (the gates check
 * that by reading what imports it).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RUNTIME_ORIGIN } from "../harness/runtime.js";

export type PinnedModel = {
  name: string;
  digest: string;
  size: number;
  /** Measured on the research questions (docs/models.md); absent if never measured. */
  research_recall?: number;
  median_seconds?: number;
  /** The memory the runtime reported while this model answered, in GB. */
  memory_gb?: number;
  /** Finished enough questions to be ranked; an unranked model is offered but never the default. */
  ranked?: boolean;
  /** "reading" for the model that reads documents, which answers nothing. */
  role?: string;
};
export type PullOutcome =
  | { ok: true; name: string; digest: string; already_held: boolean }
  | { ok: false; name: string; reason: string };

export function manifest(): PinnedModel[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, "manifest.json"), "utf8");
  return (JSON.parse(raw) as { models: PinnedModel[] }).models;
}

/**
 * The runtime answers with the tag it stored, so a model asked for as `nomic-embed-text` comes back
 * as `nomic-embed-text:latest`. Keyed on the raw name, this map reported a held model as missing,
 * and then a pull of it as a digest mismatch. Nothing caught it because nothing called this module.
 */
const untagged = (name: string) => name.replace(/:latest$/, "");

export async function held(): Promise<Map<string, string>> {
  const res = await fetch(`${RUNTIME_ORIGIN}/api/tags`);
  const body = (await res.json()) as { models?: Array<{ name: string; digest: string }> };
  const out = new Map<string, string>();
  for (const m of body.models ?? []) {
    out.set(m.name, m.digest);
    out.set(untagged(m.name), m.digest);
  }
  return out;
}

/**
 * Every pinned model with what the runtime holds of it, in words. One place, because the command
 * line printed this and the shell's "This record" panel shows it, and two copies of a judgment
 * about a digest drift apart.
 */
export async function modelStates(): Promise<Array<PinnedModel & { held: boolean; matches: boolean; state: string }>> {
  const have = await held();
  return manifest().map((m) => {
    const got = have.get(m.name);
    const state =
      got === undefined ? "NOT HELD" : got === m.digest ? "held, digest matches" : `held at ${got.slice(0, 12)}, NOT the pinned digest`;
    return { ...m, held: got !== undefined, matches: got === m.digest, state };
  });
}

/** What the manifest names and the runtime does not hold at the pinned digest. */
export async function missing(): Promise<Array<{ name: string; reason: string }>> {
  const have = await held();
  const out: Array<{ name: string; reason: string }> = [];
  for (const pin of manifest()) {
    const got = have.get(pin.name);
    if (got === undefined) out.push({ name: pin.name, reason: "not held" });
    else if (got !== pin.digest) out.push({ name: pin.name, reason: `held digest ${got.slice(0, 12)} is not the pinned ${pin.digest.slice(0, 12)}` });
  }
  return out;
}

/** Pull one pinned model. A name that is not in the manifest is refused before any request is made. */
export async function pull(name: string): Promise<PullOutcome> {
  const pin = manifest().find((m) => m.name === name);
  if (!pin) return { ok: false, name, reason: "not in the pinned manifest, so it is not downloaded" };

  const have = await held();
  if (have.get(name) === pin.digest) return { ok: true, name, digest: pin.digest, already_held: true };
  if (have.has(name) && have.get(name) !== pin.digest) {
    return { ok: false, name, reason: `held digest ${have.get(name)} is not the pinned ${pin.digest}` };
  }

  const res = await fetch(`${RUNTIME_ORIGIN}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: name, stream: false }),
  });
  if (!res.ok) return { ok: false, name, reason: `pull failed: HTTP ${res.status}` };

  const after = await held();
  if (after.get(name) !== pin.digest) {
    return { ok: false, name, reason: `after pulling, the digest is ${after.get(name)} and not the pinned ${pin.digest}` };
  }
  return { ok: true, name, digest: pin.digest, already_held: false };
}
