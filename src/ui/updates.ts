/**
 * The app's own settings, in the shell's profile beside the recent folders and never in a record:
 * whether to check for updates when the app opens (off by default), and the appearance (the Mac's,
 * unless the person picks light or dark). The rule for launch lives here too: check when the app
 * opens only if the person has switched that on.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkForUpdate, type UpdateCheck } from "../download/update.js";

export type Appearance = "system" | "light" | "dark";
export type UpdateSettings = { checkAtLaunch: boolean; appearance: Appearance };
const FILE = "settings.json";
const APPEARANCES: Appearance[] = ["system", "light", "dark"];
export const isAppearance = (v: unknown): v is Appearance => APPEARANCES.includes(v as Appearance);

export function readSettings(profileDir: string): UpdateSettings {
  try {
    const body = JSON.parse(readFileSync(join(profileDir, FILE), "utf8")) as { checkAtLaunch?: unknown; appearance?: unknown };
    return { checkAtLaunch: body.checkAtLaunch === true, appearance: isAppearance(body.appearance) ? body.appearance : "system" };
  } catch {
    return { checkAtLaunch: false, appearance: "system" };
  }
}

/** Change some settings and keep the rest. */
export function writeSettings(profileDir: string, change: Partial<UpdateSettings>): void {
  writeFileSync(join(profileDir, FILE), JSON.stringify({ ...readSettings(profileDir), ...change }, null, 1) + "\n");
}

/** At launch: nothing at all unless the check was switched on. */
export function launchCheck(
  settings: UpdateSettings,
  run: () => Promise<UpdateCheck>,
): Promise<UpdateCheck> | null {
  if (!settings.checkAtLaunch) return null;
  return run();
}

export { checkForUpdate, type UpdateCheck };
export { bundleOf, clearLeftovers, installable, installUpdate, type Run } from "../download/install.js";
