/**
 * Installing a newer release, only when the person presses Install, and only once it has verified.
 *
 * A release publishes a disk image, `checksums.txt` listing every file's SHA-256, and
 * `checksums.txt.sig`, an Ed25519 signature over that list made by a key that exists only in the
 * release workflow. Its public half is compiled in (src/download/release-key.ts). Before anything
 * is replaced:
 *
 *   1. the list's signature verifies against the compiled-in key;
 *   2. the disk image's SHA-256 is the one the signed list gives;
 *   3. the app inside it passes `codesign --verify --strict --deep`, is signed by the same Apple team
 *      as the running app, and Gatekeeper accepts it;
 *   4. the new app, run with --version-probe, reports the version the release says, and that version
 *      is newer than the running one, so a signed older release cannot be offered as an update;
 *
 * and then the running bundle is moved aside, the new one put in its place, and the old one put back
 * if that fails. The app relaunches only when the person presses Restart. The record lives in the
 * folder the person opened, never in the app, so nothing in it is touched.
 *
 * Every step that touches the system (a request, a command, the file system) arrives as a dependency,
 * so each refusal is tested without a release, a signature from Apple or a second copy of the app.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { RELEASE_PUBLIC_KEY } from "./release-key.js";
import { compareVersions, RELEASES_URL, USER_AGENT } from "./update.js";

export type Ran = { code: number; stdout: string; stderr: string };
export type Run = (cmd: string, args: string[]) => Promise<Ran>;

export type InstallDeps = {
  fetch: typeof fetch;
  run: Run;
  /** The compiled-in public key, base64 of its 32 raw bytes. Empty in a build made without one. */
  publicKey?: string;
  /** Moving a bundle; the file system's rename unless a test stands in for a failing one. */
  rename?: (from: string, to: string) => void;
};

export type Installable = { ok: true } | { ok: false; why: string };
export type Installed =
  | { state: "ready"; version: string; says: string }
  | { state: "refused"; why: string; page?: string };

const MAX_DMG = 600 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
const DOWNLOAD_MS = 10 * 60 * 1000;
/** Where the previous bundle waits after a swap, beside the app, until the next launch removes it. */
export const previousOf = (bundle: string) => join(dirname(bundle), `.${basename(bundle)}.previous`);

/** Whether this copy could install an update at all, and if not, why, in words for the panel. */
export function installable(a: {
  packaged: boolean;
  platform: string;
  bundle: string | null;
  canWrite: (dir: string) => boolean;
  publicKey?: string;
}): Installable {
  const key = a.publicKey ?? RELEASE_PUBLIC_KEY;
  if (a.platform !== "darwin") return { ok: false, why: "Updates install themselves on a Mac only; download the new version from the release page." };
  if (!a.packaged || !a.bundle) return { ok: false, why: "This is a development copy run from source, so it updates with git, not here." };
  if (!key) return { ok: false, why: "This build has no release key, so it cannot check a release's signature and will not install one." };
  if (a.bundle.startsWith("/Volumes/") || a.bundle.includes("/AppTranslocation/")) {
    return { ok: false, why: "The app is running from its disk image, which cannot be changed. Move it to Applications first." };
  }
  if (!a.canWrite(dirname(a.bundle))) {
    return { ok: false, why: `This account cannot write to ${dirname(a.bundle)}, so the app cannot be replaced there.` };
  }
  return { ok: true };
}

/** The bundle a packaged app runs from: three levels above Contents/MacOS/<name>. */
export function bundleOf(execPath: string): string | null {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath);
  return m ? m[1]! : null;
}

/** `checksums.txt` in the `sha256sum` format: "<hex>  <name>" per line. */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m) out.set(m[2]!.trim(), m[1]!);
  }
  return out;
}

const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

/** Whether `sig` (base64 of a raw 64-byte signature) is the release key's signature over `text`. */
export function verifyChecksums(text: string, sig: string, publicKey: string): boolean {
  try {
    const raw = Buffer.from(publicKey, "base64");
    const signature = Buffer.from(sig.trim(), "base64");
    if (raw.length !== 32 || signature.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), format: "der", type: "spki" });
    return verify(null, Buffer.from(text, "utf8"), key, signature);
  } catch {
    return false;
  }
}

/** The Apple team that signed a bundle, read from codesign; null when it is unsigned or ad hoc. */
export async function teamOf(run: Run, bundle: string): Promise<string | null> {
  const r = await run("codesign", ["-dv", "--verbose=2", bundle]);
  const m = /^TeamIdentifier=(\S+)$/m.exec(r.stderr + r.stdout);
  return m && m[1] !== "not" ? m[1]! : null;
}

type Release = { tag_name?: string; html_url?: string; assets?: Array<{ name: string; browser_download_url: string; size: number }> };

async function getText(f: typeof fetch, url: string): Promise<string> {
  const res = await f(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${basename(url)}`);
  const body = await res.text();
  if (body.length > MAX_TEXT) throw new Error(`${basename(url)} is larger than any checksum list should be`);
  return body;
}

/** Download to a file, refusing past a size cap, and return its SHA-256. */
async function download(f: typeof fetch, url: string, dest: string): Promise<string> {
  const res = await f(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(DOWNLOAD_MS) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} downloading ${basename(url)}`);
  let seen = 0;
  const hash = createHash("sha256");
  const capped = Readable.fromWeb(res.body as any).map((chunk: Buffer) => {
    seen += chunk.length;
    if (seen > MAX_DMG) throw new Error(`${basename(url)} is larger than ${MAX_DMG / 1024 / 1024} MB, so it is not the app`);
    hash.update(chunk);
    return chunk;
  });
  await pipeline(capped, createWriteStream(dest));
  return hash.digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/**
 * Fetch, verify and swap. Returns "ready" with the new version, or "refused" with why; a refusal
 * leaves the running app exactly as it was.
 */
export async function installUpdate(running: string, bundle: string, deps: InstallDeps): Promise<Installed> {
  const key = deps.publicKey ?? RELEASE_PUBLIC_KEY;
  const { run } = deps;
  const rename = deps.rename ?? renameSync;
  let page: string | undefined;
  const work = mkdtempSync(join(dirname(bundle), ".bearing-diligence-update-"));
  const mount = join(work, "mnt");
  let mounted = false;
  const refuse = (why: string): Installed => ({ state: "refused", why, page });
  try {
    const res = await deps.fetch(RELEASES_URL, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return refuse(`GitHub answered HTTP ${res.status} for the latest release.`);
    const rel = (await res.json()) as Release;
    page = typeof rel.html_url === "string" ? rel.html_url : undefined;
    const version = String(rel.tag_name ?? "").replace(/^v/, "");
    const cmp = compareVersions(running, version);
    if (cmp === null) return refuse(`The release's version "${rel.tag_name}" cannot be compared with this one.`);
    if (cmp >= 0) return refuse(`Version ${version} is not newer than this one (${running}), so it is not installed.`);

    const asset = (name: string) => rel.assets?.find((a) => a.name === name);
    const dmg = rel.assets?.find((a) => a.name.endsWith(".dmg"));
    const sums = asset("checksums.txt");
    const sig = asset("checksums.txt.sig");
    if (!dmg || !sums || !sig) return refuse("The release is missing its disk image, its checksum list or that list's signature.");

    // 1. The signed list.
    const list = await getText(deps.fetch, sums.browser_download_url);
    const signature = await getText(deps.fetch, sig.browser_download_url);
    if (!verifyChecksums(list, signature, key)) {
      return refuse("The release's checksum list is not signed by this app's release key, so nothing from it is trusted.");
    }
    const want = parseChecksums(list).get(dmg.name);
    if (!want) return refuse(`The signed checksum list does not name ${dmg.name}.`);

    // 2. The disk image, against the list.
    const file = join(work, dmg.name);
    const got = await download(deps.fetch, dmg.browser_download_url, file);
    if (got !== want) return refuse(`${dmg.name} does not match its signed checksum, so it was not opened.`);

    // 3. The app inside it: Apple's signature, the same team as this app, and Gatekeeper.
    const attach = await run("hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount, file]);
    if (attach.code !== 0) return refuse(`The disk image would not open: ${attach.stderr.trim()}`);
    mounted = true;
    const name = readdirSync(mount).find((n) => n.endsWith(".app"));
    if (!name) return refuse("The disk image holds no app.");
    const fresh = join(mount, name);
    const strict = await run("codesign", ["--verify", "--strict", "--deep", fresh]);
    if (strict.code !== 0) return refuse(`The new app's signature does not verify: ${strict.stderr.trim()}`);
    const ours = await teamOf(run, bundle);
    const theirs = await teamOf(run, fresh);
    if (!ours) return refuse("This app is not signed by an Apple team, so there is nothing to compare the new one with.");
    if (theirs !== ours) return refuse(`The new app is signed by team ${theirs ?? "none"}, not ${ours}, so it is not this publisher's.`);
    const gate = await run("spctl", ["--assess", "--type", "execute", fresh]);
    if (gate.code !== 0) return refuse(`Gatekeeper does not accept the new app: ${gate.stderr.trim()}`);

    // 4. It runs, and is the version the release says.
    const exe = join(fresh, "Contents", "MacOS", name.replace(/\.app$/, ""));
    const probe = await run(exe, ["--version-probe"]);
    const said = probe.stdout.trim();
    if (probe.code !== 0 || said !== version) {
      return refuse(`The new app reports version "${said || "nothing"}", where the release says ${version}.`);
    }

    // The swap. Copied onto this volume first, so the two renames cannot cross a disk.
    const staged = join(work, name);
    const copy = await run("ditto", [fresh, staged]);
    if (copy.code !== 0) return refuse(`The new app could not be copied out of the disk image: ${copy.stderr.trim()}`);
    const previous = previousOf(bundle);
    rmSync(previous, { recursive: true, force: true });
    rename(bundle, previous);
    try {
      rename(staged, bundle);
    } catch (e) {
      rename(previous, bundle);
      return refuse(`The new app could not be put in place, so the old one was put back: ${(e as Error).message}`);
    }
    return { state: "ready", version, says: `Version ${version} is installed. Restart to use it.` };
  } catch (e) {
    return refuse(`The update stopped: ${(e as Error).message}`);
  } finally {
    if (mounted) await run("hdiutil", ["detach", mount, "-quiet"]).catch(() => undefined);
    rmSync(work, { recursive: true, force: true });
  }
}

/** At launch: remove what a finished update left beside the app. */
export function clearLeftovers(bundle: string): void {
  rmSync(previousOf(bundle), { recursive: true, force: true });
  const dir = dirname(bundle);
  if (!existsSync(dir)) return;
  for (const n of readdirSync(dir)) {
    if (n.startsWith(".bearing-diligence-update-")) rmSync(join(dir, n), { recursive: true, force: true });
  }
}
