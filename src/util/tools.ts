/**
 * Where a command-line tool this app runs (the model runtime, the OCR engine) is installed.
 *
 * An app opened from the Finder gets the system PATH, `/usr/bin:/bin:/usr/sbin:/sbin`, which holds
 * neither Homebrew's tools nor the `ollama` that Ollama.app links into /usr/local/bin. Spawning a
 * bare name therefore works from a terminal and fails for everyone who downloads the app. This looks
 * in the places those installers actually put things, in order, and says which one it used.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export type Found = { path: string; where: string };

/** Places to look beyond PATH, per tool. The app bundles keep their command inside Resources. */
const EXTRA: Record<string, (home: string) => string[]> = {
  ollama: (home) => [
    "/Applications/Ollama.app/Contents/Resources/ollama",
    join(home, "Applications/Ollama.app/Contents/Resources/ollama"),
  ],
};

/**
 * `BD_TOOLS_PATH_ONLY=1` looks on PATH and nowhere else, so a test can stand for a machine that has
 * no such tool installed, whatever this one has.
 */
export function findTool(
  name: string,
  env: { PATH?: string; BD_TOOLS_PATH_ONLY?: string } = process.env,
  exists: (p: string) => boolean = existsSync,
  home: string = homedir(),
): Found | null {
  const onPath = (env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => ({ path: join(d, name), where: `${d} (on PATH)` }));
  if (env.BD_TOOLS_PATH_ONLY === "1") return onPath.find((c) => exists(c.path)) ?? null;
  const candidates: Found[] = [
    ...onPath,
    { path: join("/opt/homebrew/bin", name), where: "Homebrew" },
    { path: join("/usr/local/bin", name), where: "/usr/local/bin" },
    ...(EXTRA[name]?.(home) ?? []).map((p) => ({ path: p, where: p.replace(home, "~").split("/Contents/")[0]! })),
  ];
  return candidates.find((c) => exists(c.path)) ?? null;
}
