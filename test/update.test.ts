/**
 * The update check, against a fake releases feed, and the launch rule: nothing at launch unless it was
 * switched it on.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkForUpdate, compareVersions, RELEASES_URL, USER_AGENT } from "../src/download/update.js";
import { launchCheck, readSettings, writeSettings } from "../src/ui/updates.js";

type Seen = { url: string; headers: Record<string, string> };

function feed(status: number, body: unknown, seen: Seen[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

const release = (tag: string) => ({
  tag_name: tag,
  published_at: "2026-10-01T12:00:00Z",
  body: "What changed",
  html_url: "https://github.com/news-community/bearing-diligence-oss/releases/tag/" + tag,
});

test("versions compare as semantic versions, and anything else cannot be compared", () => {
  assert.equal(compareVersions("0.1.0", "0.2.0"), -1);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("0.1.0", "nightly"), null);
});

test("a newer release is reported with its version, date, notes and page", async () => {
  const r = await checkForUpdate("0.1.0", feed(200, release("v0.2.0")));
  assert.equal(r.state, "newer");
  assert.equal(r.latest, "0.2.0");
  assert.equal(r.published, "2026-10-01");
  assert.equal(r.notes, "What changed");
  assert.match(r.says, /0\.2\.0 is available/);
});

test("the same or an older release is current, never offered as an update", async () => {
  assert.equal((await checkForUpdate("0.2.0", feed(200, release("v0.2.0")))).state, "current");
  assert.equal((await checkForUpdate("0.3.0", feed(200, release("v0.2.0")))).state, "current");
});

test("a private repository or no release yet is said plainly, not reported as an error", async () => {
  const r = await checkForUpdate("0.1.0", feed(404, { message: "Not Found" }));
  assert.equal(r.state, "none-published");
  assert.match(r.says, /No release has been published yet/);
});

test("an unreachable or unreadable feed says so, and a tag that is not a version cannot be compared", async () => {
  const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  assert.equal((await checkForUpdate("0.1.0", down)).state, "unreachable");
  assert.equal((await checkForUpdate("0.1.0", feed(500, {}))).state, "unreachable");
  assert.equal((await checkForUpdate("0.1.0", feed(200, "not json"))).state, "unreachable");
  assert.equal((await checkForUpdate("0.1.0", feed(200, release("nightly")))).state, "cannot-compare");
});

test("the request carries nothing about the person: the fixed address, a fixed user agent, no version", async () => {
  const seen: Seen[] = [];
  await checkForUpdate("0.1.0", feed(200, release("v0.2.0"), seen));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, RELEASES_URL);
  assert.deepEqual(Object.keys(seen[0]!.headers).sort(), ["Accept", "User-Agent"]);
  assert.equal(seen[0]!.headers["User-Agent"], USER_AGENT);
  assert.ok(!JSON.stringify(seen[0]).includes("0.1.0"), "the running version is never sent");
});

test("at launch nothing is checked unless it was switched on, and the setting is off by default", async () => {
  const profile = mkdtempSync(join(tmpdir(), "bd-settings-"));
  assert.deepEqual(readSettings(profile), { checkAtLaunch: false, appearance: "system" });
  let runs = 0;
  const run = async () => { runs++; return checkForUpdate("0.1.0", feed(404, {})); };
  assert.equal(launchCheck(readSettings(profile), run), null);
  assert.equal(runs, 0, "off means no request at all");
  writeSettings(profile, { checkAtLaunch: true });
  assert.equal((await launchCheck(readSettings(profile), run))?.state, "none-published");
  assert.equal(runs, 1);
  rmSync(profile, { recursive: true, force: true });
});

test("appearance follows the Mac unless a person picks one, and changing it keeps the other setting", () => {
  const profile = mkdtempSync(join(tmpdir(), "bd-appearance-"));
  writeSettings(profile, { checkAtLaunch: true });
  writeSettings(profile, { appearance: "dark" });
  assert.deepEqual(readSettings(profile), { checkAtLaunch: true, appearance: "dark" });
  writeSettings(profile, { appearance: "purple" as never });
  assert.equal(readSettings(profile).appearance, "system", "anything else reads as the Mac's own");
  rmSync(profile, { recursive: true, force: true });
});
