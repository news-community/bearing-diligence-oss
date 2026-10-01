/**
 * Installing an update: it happens only once the release verifies, and every refusal leaves the
 * running app as it was. The release, Apple's tools and the file system are stand-ins; the signature
 * check and the swap are the real code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundleOf,
  clearLeftovers,
  installable,
  installUpdate,
  parseChecksums,
  previousOf,
  verifyChecksums,
  type Ran,
} from "../src/download/install.js";
import { RELEASES_URL } from "../src/download/update.js";

const SPKI_LEN = 12;
function keys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_LEN).toString("base64");
  return { pub, privateKey };
}

/** A folder standing for /Applications, holding a "running" app whose one file says which version it is. */
function applications(version: string) {
  const dir = mkdtempSync(join(tmpdir(), "bd-install-"));
  const bundle = join(dir, "Bearing Diligence.app");
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(bundle, "Contents", "MacOS", "Bearing Diligence"), version);
  return { dir, bundle };
}

type Opts = {
  tag?: string;
  dmgBytes?: Buffer;
  listedSha?: string;
  signWith?: ReturnType<typeof keys>["privateKey"];
  noSig?: boolean;
  newTeam?: string;
  probeSays?: string;
  gatekeeper?: number;
};

/** A release on a stand-in GitHub, and stand-ins for hdiutil, codesign, spctl, ditto and the probe. */
function release(k: ReturnType<typeof keys>, o: Opts = {}) {
  const tag = o.tag ?? "v0.2.0";
  const dmg = o.dmgBytes ?? Buffer.from("a disk image");
  const sha = o.listedSha ?? createHash("sha256").update(dmg).digest("hex");
  const list = `${sha}  Bearing-Diligence-${tag.slice(1)}-arm64.dmg\n`;
  const sig = sign(null, Buffer.from(list), o.signWith ?? k.privateKey).toString("base64");
  const base = "https://example.invalid/dl/";
  const assets = [
    { name: `Bearing-Diligence-${tag.slice(1)}-arm64.dmg`, browser_download_url: base + "dmg", size: dmg.length },
    { name: "checksums.txt", browser_download_url: base + "sums", size: list.length },
    ...(o.noSig ? [] : [{ name: "checksums.txt.sig", browser_download_url: base + "sig", size: sig.length }]),
  ];
  const requested: string[] = [];
  const fetchStub = (async (url: string) => {
    requested.push(String(url));
    if (url === RELEASES_URL) return new Response(JSON.stringify({ tag_name: tag, html_url: "https://example.invalid/r", assets }));
    if (url === base + "sums") return new Response(list);
    if (url === base + "sig") return new Response(sig);
    if (url === base + "dmg") return new Response(dmg);
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const ran: string[] = [];
  const run = async (cmd: string, args: string[]): Promise<Ran> => {
    ran.push(cmd);
    const ok = { code: 0, stdout: "", stderr: "" };
    if (cmd === "hdiutil" && args[0] === "attach") {
      const mount = args[args.indexOf("-mountpoint") + 1]!;
      const app = join(mount, "Bearing Diligence.app", "Contents", "MacOS");
      mkdirSync(app, { recursive: true });
      writeFileSync(join(app, "Bearing Diligence"), tag.slice(1));
      return ok;
    }
    if (cmd === "codesign" && args[0] === "-dv") {
      const team = args[2]!.includes("/mnt/") ? (o.newTeam ?? "TEAM123") : "TEAM123";
      return { code: 0, stdout: "", stderr: `Executable=x\nTeamIdentifier=${team}\n` };
    }
    if (cmd === "spctl") return { code: o.gatekeeper ?? 0, stdout: "", stderr: o.gatekeeper ? "rejected" : "accepted" };
    if (cmd === "ditto") {
      cpSync(args[0]!, args[1]!, { recursive: true });
      return ok;
    }
    if (cmd.endsWith("/Contents/MacOS/Bearing Diligence")) return { code: 0, stdout: (o.probeSays ?? tag.slice(1)) + "\n", stderr: "" };
    return ok;
  };
  return { fetch: fetchStub, run, ran, requested, publicKey: k.pub };
}

const versionOf = (bundle: string) => readFileSync(join(bundle, "Contents", "MacOS", "Bearing Diligence"), "utf8");

test("a verified release replaces the app, and the old one waits beside it until the next launch", async () => {
  const k = keys();
  const { dir, bundle } = applications("0.1.0");
  const r = await installUpdate("0.1.0", bundle, release(k));
  assert.equal(r.state, "ready", JSON.stringify(r));
  assert.equal(versionOf(bundle), "0.2.0");
  assert.equal(versionOf(previousOf(bundle)), "0.1.0");
  clearLeftovers(bundle);
  assert.equal(existsSync(previousOf(bundle)), false);
  rmSync(dir, { recursive: true, force: true });
});

/** A release refused for `why`, with the running app left exactly as it was. */
async function refused(opts: Opts, why: RegExp) {
  const { dir, bundle } = applications("0.1.0");
  const r = await installUpdate("0.1.0", bundle, release(keys(), opts));
  assert.equal(r.state, "refused");
  assert.match((r as { why: string }).why, why);
  assert.equal(versionOf(bundle), "0.1.0");
  assert.equal(existsSync(previousOf(bundle)), false);
  rmSync(dir, { recursive: true, force: true });
}

test("refused: a list signed by another key", () => refused({ signWith: keys().privateKey }, /not signed by this app's release key/));
test("refused: a release with no signature", () => refused({ noSig: true }, /missing/));
test("refused: a disk image that does not match its signed checksum", () => refused({ listedSha: "0".repeat(64) }, /does not match its signed checksum/));
test("refused: an older release, even signed", () => refused({ tag: "v0.0.9" }, /not newer/));
test("refused: the same version", () => refused({ tag: "v0.1.0" }, /not newer/));
test("refused: an app signed by another team", () => refused({ newTeam: "OTHER99" }, /not this publisher's/));
test("refused: an app Gatekeeper rejects", () => refused({ gatekeeper: 3 }, /Gatekeeper does not accept/));
test("refused: an app that reports a different version from its release", () => refused({ probeSays: "0.3.0" }, /reports version "0.3.0"/));

test("a swap that fails halfway puts the old app back", async () => {
  const k = keys();
  const { dir, bundle } = applications("0.1.0");
  const rel = release(k);
  const r = await installUpdate("0.1.0", bundle, {
    ...rel,
    rename: (from, to) => {
      if (to === bundle && !from.endsWith(".previous")) throw new Error("disk full");
      renameSync(from, to);
    },
  });
  assert.equal(r.state, "refused");
  assert.match((r as { why: string }).why, /old one was put back/);
  assert.equal(versionOf(bundle), "0.1.0");
  rmSync(dir, { recursive: true, force: true });
});

test("a refused signature stops before the disk image is downloaded or opened", async () => {
  const k = keys();
  const { dir, bundle } = applications("0.1.0");
  const rel = release(k, { signWith: keys().privateKey });
  await installUpdate("0.1.0", bundle, rel);
  assert.equal(rel.requested.some((u) => u.endsWith("/dmg")), false);
  assert.equal(rel.ran.includes("hdiutil"), false);
  rmSync(dir, { recursive: true, force: true });
});

test("a build with no release key refuses rather than installing what it cannot check", async () => {
  const { dir, bundle } = applications("0.1.0");
  const r = await installUpdate("0.1.0", bundle, { ...release(keys()), publicKey: "" });
  assert.equal(r.state, "refused");
  assert.equal(versionOf(bundle), "0.1.0");
  rmSync(dir, { recursive: true, force: true });
});

test("verifyChecksums: the right key verifies, an edited list or another key does not", () => {
  const k = keys();
  const list = "ab".repeat(32) + "  x.dmg\n";
  const sig = sign(null, Buffer.from(list), k.privateKey).toString("base64");
  assert.equal(verifyChecksums(list, sig, k.pub), true);
  assert.equal(verifyChecksums(list.replace("x.dmg", "y.dmg"), sig, k.pub), false);
  assert.equal(verifyChecksums(list, sig, keys().pub), false);
  assert.equal(verifyChecksums(list, "", k.pub), false);
  assert.deepEqual([...parseChecksums(list)], [["x.dmg", "ab".repeat(32)]]);
});

test("installable: offered only where it can work, and says why everywhere else", () => {
  const base = { packaged: true, platform: "darwin", bundle: "/Applications/Bearing Diligence.app", canWrite: () => true, publicKey: "k" };
  assert.deepEqual(installable(base), { ok: true });
  const why = (o: Partial<typeof base> & { bundle?: string | null }) => {
    const r = installable({ ...base, ...o });
    return r.ok ? "" : r.why;
  };
  assert.match(why({ packaged: false }), /development copy/);
  assert.match(why({ publicKey: "" }), /no release key/);
  assert.match(why({ bundle: "/Volumes/Bearing Diligence/Bearing Diligence.app" }), /disk image/);
  assert.match(why({ bundle: "/private/var/folders/x/AppTranslocation/y/d/Bearing Diligence.app" }), /disk image/);
  assert.match(why({ canWrite: () => false }), /cannot write/);
  assert.match(why({ platform: "linux" }), /Mac only/);
});

test("bundleOf reads the bundle from a packaged app's executable, and nothing from a development one", () => {
  assert.equal(bundleOf("/Applications/Bearing Diligence.app/Contents/MacOS/Bearing Diligence"), "/Applications/Bearing Diligence.app");
  assert.equal(bundleOf("/x/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), "/x/node_modules/electron/dist/Electron.app");
  assert.equal(bundleOf("/usr/local/bin/node"), null);
});
