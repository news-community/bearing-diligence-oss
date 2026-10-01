/**
 * The model runtime: the Ollama server binary, on its own loopback port, started and stopped here.
 *
 * Never the desktop application, which updates itself. Never the port an
 * existing install is already using, because two servers sharing one port do not reliably fail.
 */
import { spawn, ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/** Pinned in code. 1948 is chosen to stay clear of the runtime's own default port, 11434, and of anything else on the machine. */
export const RUNTIME_HOST = "127.0.0.1";
export const RUNTIME_PORT = 1948;
export const RUNTIME_ORIGIN = `http://${RUNTIME_HOST}:${RUNTIME_PORT}`;

let child: ChildProcess | null = null;

export type Identity =
  | { answering: false; detail: string }
  | { answering: true; speaks_the_protocol: boolean; version: string; models: string[]; detail: string };

/**
 * WHO is answering on the port, not merely WHETHER anything is.
 *
 * "Something answered on 1948" and "our runtime is on 1948" are different claims, and on the
 * machine this was built on there were FOUR model servers listening at once, including a desktop
 * application serving its own model. A check that accepts any responder is an instrument that
 * cannot tell you what it measured.
 *
 * What this can see: that the responder speaks the runtime's protocol and which models it holds.
 * What it CANNOT see: whether the binary is the bundled one. Nothing short of launching it
 * ourselves establishes that, which is why startRuntime does launch it.
 */
export async function identify(timeoutMs = 1500): Promise<Identity> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const v = await fetch(`${RUNTIME_ORIGIN}/api/version`, { signal: ac.signal });
    if (!v.ok) return { answering: false, detail: `HTTP ${v.status} from ${RUNTIME_ORIGIN}/api/version` };
    const body = (await v.json()) as { version?: string };
    const version = String(body.version ?? "");
    const t = await fetch(`${RUNTIME_ORIGIN}/api/tags`, { signal: ac.signal });
    const tags = t.ok ? ((await t.json()) as { models?: Array<{ name: string }> }) : { models: [] };
    const models = (tags.models ?? []).map((m) => m.name);
    const speaks = /^\d+\.\d+/.test(version);
    return {
      answering: true,
      speaks_the_protocol: speaks,
      version,
      models,
      detail: speaks
        ? `a runtime answering version ${version} with ${models.length} model(s)`
        : `something is answering on ${RUNTIME_ORIGIN} and it is not the runtime`,
    };
  } catch (e) {
    return { answering: false, detail: `${RUNTIME_ORIGIN}: ${(e as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function isUp(timeoutMs = 1500): Promise<boolean> {
  const who = await identify(timeoutMs);
  return who.answering && who.speaks_the_protocol;
}

export async function startRuntime(modelsDir = join(homedir(), ".ollama", "models")): Promise<"already" | "started"> {
  if (await isUp()) return "already";
  child = spawn("ollama", ["serve"], {
    env: { ...process.env, OLLAMA_HOST: `${RUNTIME_HOST}:${RUNTIME_PORT}`, OLLAMA_MODELS: modelsDir },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  // spawn does not THROW when the binary is missing: it emits "error", and an error event with no
  // listener is rethrown as an uncaught exception that kills the process. In a packaged
  // application PATH is the minimal launchd one, so a runtime installed by homebrew is exactly the
  // case that hits this, and the message the person needs never printed.
  let spawnFailure = "";
  child.on("error", (e) => {
    spawnFailure = (e as NodeJS.ErrnoException).code === "ENOENT"
      ? "no `ollama` on PATH. In a packaged application PATH is the system one, so a runtime installed for your shell is not visible to it."
      : `the runtime could not be started: ${e.message}`;
  });
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (spawnFailure) throw new Error(spawnFailure);
    if (await isUp()) return "started";
  }
  throw new Error(spawnFailure || `the runtime did not answer on ${RUNTIME_ORIGIN} within 15 seconds`);
}

export function stopRuntime(): void {
  if (child && !child.killed) child.kill("SIGTERM");
  child = null;
}
