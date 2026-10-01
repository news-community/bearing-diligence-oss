/**
 * A DEVELOPMENT server, so the interface can be driven in a browser before Electron wraps it.
 *
 * It binds 127.0.0.1 on an EPHEMERAL port, which is why it cannot collide with anything and why it
 * is not a fixed port: the shipped application binds nothing at all and talks to
 * the record over Electron IPC.
 *
 * It lives under tools/ rather than src/ because it is NOT the application. The forbidden-reference
 * gate found it importing node:http, which was correct: nothing in src/ may bind a port, and the
 * way to keep that true is to put the thing that binds one outside src/ rather than to exempt it.
 *
 * Every route comes from the one table of handlers (src/ui/api.ts), the same one the shell's IPC is
 * built from. A name the table marks shell-only answers with the table's own sentence, because a
 * method that silently does nothing is how the marks panel once rendered empty.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openRecord, type Record as OpenRecord } from "../../src/record/db.js";
import { API, NAMES, runnerFor, type Ctx, type Name } from "../../src/ui/api.js";
import { dataDirFor } from "../../src/ui/folder.js";
import { createIntakeQueue } from "../../src/ingest/queue.js";
import { GENERAL_MODEL } from "../../src/harness/model.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const at = process.argv.indexOf("--dir");
const dir = at === -1 ? undefined : process.argv[at + 1];
if (!dir || dir.startsWith("--")) {
  console.error("usage: npm run ui -- --dir <folder of documents>");
  process.exit(2);
}

let open: OpenRecord | null = null;
const ctx: Ctx = {
  dir,
  since: null,
  version: (JSON.parse(readFileSync(join(HERE, "..", "..", "..", "package.json"), "utf8")) as { version: string }).version,
  record: () => (open ??= openRecord(dataDirFor(dir))),
  intake: createIntakeQueue({ model: GENERAL_MODEL }),
};

/**
 * The page speaks to `window.record` and nothing else, so this provides one built on fetch, from the
 * table's names, and injects it before the page's own script. The shipped renderer carries no
 * network call at all, which is what the forbidden-reference gate checks.
 */
const BRIDGE = `<script>
window.record = Object.fromEntries(${JSON.stringify(NAMES)}.map((name) => [name, (...args) =>
  fetch("/api/" + name, { method: "POST", body: JSON.stringify(args) })
    .then((r) => r.json())
    .then((b) => ("error" in b ? Promise.reject(new Error(b.error)) : b.value))]));
</script>`;

const page = readFileSync(join(HERE, "..", "..", "src", "ui", "app.html"), "utf8").replace("<script>", `${BRIDGE}\n<script>`);

const ASSETS: Record<string, string> = {
  "/fonts/geist-latin-wght-normal.woff2": "font/woff2",
  "/fonts/newsreader-latin-wght-normal.woff2": "font/woff2",
  "/fonts/newsreader-latin-wght-italic.woff2": "font/woff2",
  "/icon/bear.svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  const send = (code: number, body: string, type: string) => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/") return send(200, page, "text/html; charset=utf-8");
  // The page's fonts and mark, which the build copies beside it. A fixed list rather than a path
  // read from the request, so nothing outside these files can be asked for.
  const asset = ASSETS[url.pathname];
  if (asset) {
    res.writeHead(200, { "content-type": asset, "cache-control": "no-store" });
    return res.end(readFileSync(join(HERE, "..", "..", "src", "ui", url.pathname.slice(1))));
  }

  const name = url.pathname.replace(/^\/api\//, "") as Name;
  if (!url.pathname.startsWith("/api/") || !NAMES.includes(name)) {
    return send(404, JSON.stringify({ error: "no such method" }), "application/json");
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  try {
    const run = runnerFor(name);
    const entry = API[name];
    if (!run) return send(200, JSON.stringify({ error: "shellOnly" in entry ? entry.shellOnly : "" }), "application/json");
    const args = body ? (JSON.parse(body) as unknown[]) : [];
    return send(200, JSON.stringify({ value: await run(ctx, ...args) }), "application/json");
  } catch (e) {
    return send(200, JSON.stringify({ error: (e as Error).message }), "application/json");
  }
});

server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  console.log(`the record is at http://127.0.0.1:${port} (development only, ephemeral port)`);
  console.log(`folder: ${dir}`);
});
