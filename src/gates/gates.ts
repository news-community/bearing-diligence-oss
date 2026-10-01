/**
 * The refusals, checked by reading the code rather than by trusting it.
 *
 * Same contract as the document senses in scripts/checks.py: every gate declares what it CANNOT
 * see, and every gate ships with a case built to make it fire. A gate that has only ever been seen
 * agreeing has not been shown to be a gate.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { toolsOffered } from "../harness/model.js";
import { RUNTIME_HOST, RUNTIME_ORIGIN } from "../harness/runtime.js";

export type Gate = {
  name: string;
  sees: string;
  blindTo: string;
  run: (root: string, opts?: GateOpts) => string[];
};
export type GateOpts = { toolsOf?: (mode: "ingestion" | "question") => string[] };

const DOWNLOAD_MODULE = "src/download/";
/** The one hosted model path, chosen per folder (docs/design.md, "What leaves the machine"). */
const CLOUD_MODULE = "src/cloud/";


function sources(root: string): Array<{ path: string; rel: string; text: string }> {
  const out: Array<{ path: string; rel: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|mjs|cjs|py|html)$/.test(p)) {
        out.push({ path: p, rel: relative(root, p).replace(/\\/g, "/"), text: readFileSync(p, "utf8") });
      }
    }
  };
  // Every directory the application is built from, not only src/. The gate read src/ alone until
  // 2026-09-22, and `package.json` names `dist/app/main.js` as the entry point: a review planted a
  // beacon in `app/main.ts` and all five gates printed pass. A gate that cannot see the shipped
  // entry point is not a gate over the application.
  //
  // tools/ is deliberately NOT walked: it holds the development server, which binds a port, and the
  // hosted comparison, which reaches a vendor on purpose and refuses to run without an explicit
  // acknowledgement. Named here rather than left as an accident of the walk list.
  for (const dir of ["src", "app", "sidecar", "scripts"]) {
    if (existsSync(join(root, dir))) walk(join(root, dir));
  }
  return out;
}

const NETWORK_IMPORT = /(?:from|require\()\s*['"](node:https?|node:net|node:dgram|node:tls|axios|got|undici|node-fetch|ws)['"]/;
const URL_LITERAL = /https?:\/\/([A-Za-z0-9._-]+)/g;
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|\$\{RUNTIME_HOST\})/;

export const forbiddenReference: Gate = {
  name: "forbidden reference",
  sees: "a network client imported, a fetch call, or a URL naming any host but loopback, outside the download module and the cloud module; and in the cloud module, any host but OpenRouter's",
  blindTo:
    "a host assembled at runtime from pieces, anything a DEPENDENCY does, and everything under tools/, which holds the development server and the hosted comparison on purpose. src/harness/ is exempt from the fetch rule because it is the one module allowed to speak to the model",
  run(root) {
    const out: string[] = [];
    for (const f of sources(root)) {
      const inDownload = f.rel.startsWith(DOWNLOAD_MODULE);
      const inCloud = f.rel.startsWith(CLOUD_MODULE);
      if (!inDownload) {
        if (NETWORK_IMPORT.test(f.text)) out.push(`${f.rel} imports a network client`);
        for (const m of f.text.matchAll(/\bfetch\s*\(/g)) {
          if (!f.rel.startsWith("src/harness/") && !inCloud) out.push(`${f.rel} calls fetch at offset ${m.index}`);
        }
      }
      for (const m of f.text.matchAll(URL_LITERAL)) {
        const host = m[1] ?? "";
        if (LOOPBACK.test(host)) continue;
        if (inDownload) continue;
        if (inCloud && host === CLOUD_HOST) continue;
        out.push(`${f.rel} carries the URL host ${host}`);
      }
    }
    return out;
  },
};

// Read from data, not written here: see hosted-providers.json for why.
const HOSTED: string[] = (
  JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "hosted-providers.json"), "utf8")) as {
    hosts: string[];
  }
).hosts;

/** The only host the cloud module may name, read from data for the reason given above. */
const CLOUD_HOST: string = (
  JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "hosted-providers.json"), "utf8")) as { cloud: string }
).cloud;

export const noFallback: Gate = {
  name: "no fallback",
  sees: "any hosted model provider named anywhere in the source but the cloud module, and any but OpenRouter named inside it",
  blindTo:
    "a provider nobody here has heard of, a host arriving as data rather than as source, and every file that is not .ts, .js or .mjs",
  run(root) {
    const out: string[] = [];
    for (const f of sources(root)) {
      const inCloud = f.rel.startsWith(CLOUD_MODULE);
      for (const host of HOSTED) {
        if (inCloud && host === CLOUD_HOST) continue;
        if (f.text.includes(host)) out.push(`${f.rel} names ${host}`);
      }
    }
    return out;
  },
};

export const loopbackPinned: Gate = {
  name: "loopback pinned",
  sees: "the model endpoint resolving anywhere but loopback, or being read from the environment",
  blindTo: "a loopback port forwarded to another machine by something outside this application",
  run(root) {
    const out: string[] = [];
    if (RUNTIME_HOST !== "127.0.0.1") out.push(`the runtime host is ${RUNTIME_HOST}`);
    if (!RUNTIME_ORIGIN.startsWith("http://127.0.0.1:")) out.push(`the runtime origin is ${RUNTIME_ORIGIN}`);
    for (const f of sources(root)) {
      if (!f.rel.startsWith("src/harness/")) continue;
      for (const m of f.text.matchAll(/process\.env\.([A-Z_]+)/g)) {
        const name = m[1] ?? "";
        if (/HOST|PORT|URL|ENDPOINT|ORIGIN|BASE/.test(name)) {
          out.push(`${f.rel} reads ${name} from the environment, which is an override path`);
        }
      }
    }
    return out;
  },
};

export const toolListEmpty: Gate = {
  name: "tool list empty",
  sees: "any tool offered to the model, in either mode, read from what is offered rather than from configuration",
  blindTo: "a tool a harness adds after this function is called, which is why the ingestion path is a pipeline and not an agent",
  run(_root, opts) {
    const toolsOf = opts?.toolsOf ?? toolsOffered;
    const out: string[] = [];
    for (const mode of ["ingestion", "question"] as const) {
      const tools = toolsOf(mode);
      if (tools.length) out.push(`${tools.length} tool(s) offered at ${mode}: ${tools.join(", ")}`);
    }
    return out;
  },
};

/**
 * Cloud isolated: the hosted path is reached through the chooser and nothing else.
 *
 * Reading a document, the search index, embeddings and the change record must never be able to reach
 * the cloud, whatever a folder chose, because a folder's cloud setting is a promise about ANSWERS
 * only. The chooser is the one file that imports the cloud module; everything else that needs its
 * description or its model list gets them through the chooser.
 */
export const cloudIsolated: Gate = {
  name: "cloud isolated",
  sees: "any file but the chooser (src/harness/choose.ts) importing the cloud module",
  blindTo: "a dynamic import built from a string at runtime, and what a file does with the chooser once it has it",
  run(root) {
    const out: string[] = [];
    for (const f of sources(root)) {
      if (f.rel === "src/harness/choose.ts" || f.rel.startsWith(CLOUD_MODULE)) continue;
      if (/from\s+['"][^'"]*cloud\//.test(f.text)) out.push(`${f.rel} imports the cloud module`);
    }
    return out;
  },
};

export const downloadIsolated: Gate = {
  name: "download isolated",
  sees: "ingestion or question-time code importing the download module",
  blindTo: "a dynamic import built from a string at runtime",
  run(root) {
    const out: string[] = [];
    const allowed = ["src/cli/", "src/download/", "src/gates/", "src/ui/"];
    for (const f of sources(root)) {
      if (allowed.some((a) => f.rel.startsWith(a))) continue;
      // Any file in the module, not only pull.ts: it read only `download/pull` until 2026-09-29, when the
      // update check became a second file there and would have been invisible to this gate.
      if (/from\s+['"][^'"]*download\//.test(f.text)) out.push(`${f.rel} imports the download module`);
    }
    return out;
  },
};

/**
 * One way in.
 *
 * There were two entry points that took a document in, and they did different things: the command
 * line ran OCR and read the votes off the page, and the desktop shell, the only surface a person
 * will ever touch, did neither. Both were correct code and both had tests, because a test of one
 * says nothing about the other.
 *
 * So the sequence lives in src/ingest/intake.ts and this gate keeps it there. A third entry point
 * that starts with the easy half is the way this comes back.
 */
export const singleIntake: Gate = {
  name: "one way in",
  sees: "a second path that adds a document without the sequence that reads it",
  blindTo: "a caller that reaches addDocument through a re-export, and a divergence INSIDE intake",
  run(root) {
    const out: string[] = [];
    const allowed = ["src/ingest/intake.ts", "src/record/store.ts", "src/gates/"];
    for (const f of sources(root)) {
      if (allowed.some((a) => f.rel.startsWith(a))) continue;
      // test/ is not walked at all, so no clause excludes it here: a condition that cannot come
      // back false is decoration rather than a check.
      if (/\baddDocument\b/.test(f.text)) {
        out.push(`${f.rel} adds a document without going through src/ingest/intake.ts`);
      }
    }
    return out;
  },
};

/**
 * Invariant 9, in the one form that is checkable by reading.
 *
 * The invariant is not "instruction-shaped text is blocked". It is that such text is MARKED and
 * **the mark changes nothing about retrieval or ranking**. That is a claim about what the
 * retrieval and answering path is allowed to know, and it is checkable: those modules must not
 * name the marks table, the screen, or anything it produces.
 *
 * The temptation this exists to stop is a reasonable-sounding future commit. Down-ranking a marked
 * passage, or hiding it from an answer, reads like a security improvement and is the invariant's
 * exact inverse: the record would then show the person less of their own packet because a pattern fired,
 * and the patterns are English only with unmeasured recall. A screen that quietly removes text
 * makes the record lie about what the organisation sent.
 */
export const marksDoNotRank: Gate = {
  name: "a mark changes nothing",
  sees: "the retrieval, ranking or answering path reading invariant 9's marks",
  blindTo: "a mark reaching those paths through a table this list does not name, and a column added to pages",
  run(root) {
    const out: string[] = [];
    // Everything that decides what the person is shown, or in what order.
    const deciders = ["src/answer/", "src/quote/", "src/ingest/pipeline.ts", "src/change/", "src/brief/", "src/search/"];
    const forbidden = /\b(?:FROM\s+marks|INTO\s+marks|JOIN\s+marks|listMarks|screenInstructions|hiddenText|screenDocument)\b/;
    for (const f of sources(root)) {
      if (!deciders.some((d) => f.rel.startsWith(d))) continue;
      if (forbidden.test(f.text)) {
        out.push(`${f.rel} reads invariant 9's marks, which must change nothing about retrieval or ranking`);
      }
    }
    return out;
  },
};

const readAt = (root: string, rel: string) => {
  const at = join(root, rel);
  return existsSync(at) ? readFileSync(at, "utf8") : "";
};

/** The names in the one table of handlers: the top-level keys of `export const API = {`. */
function tableNames(root: string): string[] | null {
  const text = readAt(root, "src/ui/api.ts");
  const start = text.indexOf("export const API = {");
  const end = text.indexOf("\n} satisfies", start);
  if (start === -1 || end === -1) return null;
  const body = text.slice(start, end);
  return [...body.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9_]*): \{/gm)].map((m) => m[1]!);
}

/**
 * One table behind both bridges.
 *
 * There are two ways the page reaches the record: `app/preload.cjs` in the shipped shell, and the
 * development server's injected `window.record`. Until 2026-09-28 each listed its methods by hand,
 * and this gate compared the two lists, because a method added to one and not the other made the
 * panel that used it render EMPTY with no error anywhere: the marks panel shipped blank for one
 * build exactly that way.
 *
 * Both are now built from src/ui/api.ts, so the lists cannot differ. What can still go wrong is a
 * hand-written method creeping back into either bridge, which is what this looks for.
 */
export const bridgesFromTable: Gate = {
  name: "one table behind both bridges",
  sees: "a method written by hand into either bridge, a bridge not built from the table's names, or anything exposed beyond it and the one menu channel",
  blindTo: "a handler in the table that does the wrong thing, which is what the tests are for",
  run(root) {
    const preload = readAt(root, "app/preload.cjs");
    const dev = readAt(root, "tools/ui-dev/serve.ts");
    if (!preload || !dev) return ["a bridge is missing: app/preload.cjs and tools/ui-dev/serve.ts must both exist"];
    const out: string[] = [];
    // A hand-written method is `name: (args) =>` at the top of an object literal. In the development
    // server only the injected script is a bridge; its own handler context is an object literal too,
    // and the first version of this gate reported that context's two functions as bridge methods.
    const handWritten = (text: string) => [...text.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9_]*):\s*\(/gm)].map((m) => m[1]!);
    const from = dev.indexOf("const BRIDGE = `");
    const devBridge = from === -1 ? "" : dev.slice(from, dev.indexOf("`;", from));
    if (!devBridge) out.push("the development server has no BRIDGE script to read");
    for (const n of handWritten(preload)) out.push(`app/preload.cjs writes "${n}" by hand rather than from the table`);
    for (const n of handWritten(devBridge)) out.push(`the development server writes "${n}" by hand rather than from the table`);
    if (!preload.includes('"record:names"')) out.push("app/preload.cjs does not ask the main process for the table's names");
    // One more world is allowed, and only one: "menu", a listener on the one "menu" channel, which
    // is how a menu bar command reaches the page. Anything else the preload exposes, or any other
    // channel it listens on, is a second bridge nobody built from the table.
    for (const m of preload.matchAll(/exposeInMainWorld\(\s*["']([^"']+)["']/g)) {
      if (m[1] !== "record" && m[1] !== "menu") out.push(`app/preload.cjs exposes "${m[1]}", and only "record" and "menu" are allowed`);
    }
    for (const m of preload.matchAll(/ipcRenderer\.on\(\s*["']([^"']+)["']/g)) {
      if (m[1] !== "menu") out.push(`app/preload.cjs listens on "${m[1]}", and only the "menu" channel is allowed`);
    }
    if (!/\bNAMES\b/.test(devBridge)) out.push("the development server does not build its bridge from the table's NAMES");
    return out;
  },
};

/**
 * The page calls what the table offers.
 *
 * The gate above says both bridges offer the same names, and on 2026-09-28 they both offered twelve
 * while the page called eight. Choosing a folder, confirming it, adding a document and the brief
 * were handled, offered and reachable from no control, so the shell could do nothing but refuse,
 * and every gate passed. A gate on what MAY be reached is silent on whether anything is.
 *
 * No allowlist: a name the page does not call is removed from the table or given a control.
 */
export const pageCallsTable: Gate = {
  name: "the page calls what the table offers",
  sees: "a handler in src/ui/api.ts that src/ui/app.html never calls, or a call to a name the table lacks",
  blindTo: "a call no control can reach, and a call wired to the wrong button",
  run(root) {
    const names = tableNames(root);
    const page = readAt(root, "src/ui/app.html");
    if (!names || !page) return ["the table (src/ui/api.ts) or the page (src/ui/app.html) is missing"];
    const called = new Set([...page.matchAll(/\bapi\.([a-zA-Z][a-zA-Z0-9_]*)\s*\(/g)].map((m) => m[1]!));
    const out: string[] = [];
    for (const n of names) if (!called.has(n)) out.push(`the table offers "${n}" and the page never calls it`);
    for (const n of called) if (!names.includes(n)) out.push(`the page calls "${n}" and the table has no such handler`);
    return out;
  },
};

/** WCAG 2.2 contrast between two #rrggbb colours, from their relative luminance. */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

type Role = "text" | "control" | "focus" | "mark" | "divider";
const FLOOR: Record<Role, number> = { text: 4.5, control: 3, focus: 3, mark: 3, divider: 1 };

/**
 * Every pair the page draws, by role. Text is held to 4.5:1, a control's boundary, the focus ring
 * and a mark that carries meaning to 3:1 (WCAG 2.2 SC 1.4.3 and 1.4.11). A divider is decorative
 * and exempt, and is listed so that every token is named by a pair: a colour cannot enter the
 * palette without saying what it sits on.
 */
const PAIRS: Array<[fg: string, bg: string, role: Role, where: string]> = [
  ["ink", "paper", "text", "body text"],
  ["ink", "surface", "text", "text in a card or input"],
  ["ink", "sunk", "text", "a passage or quote"],
  ["ink", "dropped-bg", "text", "a dropped sentence or stopped run"],
  ["quiet", "paper", "text", "headings, the location line, notes"],
  ["quiet", "surface", "text", "the small print in a card"],
  ["quiet", "sunk", "text", "a citation inside a passage"],
  ["quiet", "dropped-bg", "text", "a stopped run's heading, a refusal judged wrong"],
  ["dropped", "dropped-bg", "text", "why a sentence was dropped"],
  ["dropped", "surface", "text", "why, on a card"],
  ["paper", "ink", "text", "a primary button's label"],
  ["paper", "accent", "text", "a primary button's label on hover, and selected text"],
  ["accent", "paper", "text", "an outline button's label on hover"],
  ["accent", "surface", "text", "an outline button's label on hover, in a card"],
  ["control", "paper", "control", "an outline button on the page"],
  ["control", "surface", "control", "a text input, an outline button in a card"],
  ["control", "dropped-bg", "control", "a review button on a refusal judged wrong"],
  ["accent", "paper", "control", "an outline button's edge on hover"],
  ["accent", "surface", "control", "an outline button's edge on hover, in a card"],
  ["paper", "accent", "control", "a switch's thumb when on"],
  ["accent", "sunk", "text", "a citation link inside a passage"],
  ["ink", "paper", "focus", "the focus ring on the page"],
  ["ink", "surface", "focus", "the focus ring in a card"],
  ["ink", "dropped-bg", "focus", "the focus ring on a stopped run or refusal"],
  ["flag", "surface", "mark", "coverage and refusal rules"],
  ["flag", "sunk", "mark", "a change's now passage"],
  ["kept", "surface", "mark", "the reading bar, a running run, the pulse"],
  ["dropped", "surface", "mark", "a dropped rule on a card"],
  ["kept", "track", "mark", "a running bar"],
  ["dropped", "track", "mark", "a stopped bar"],
  ["rule", "paper", "divider", "section rules"],
  ["rule", "surface", "divider", "card borders"],
  ["rule", "sunk", "divider", "a change's then passage"],
  ["ink", "track", "text", "the passage marked in the source pane"],
  ["flag", "track", "mark", "the rule under the marked passage"],
  ["control", "sunk", "control", "a citation inside a passage, the undo button, a row's actions on the selected row"],
  ["dropped", "paper", "text", "the line counting sentences left out of an answer"],
];

/**
 * Every colour pair clears its floor, in both themes.
 *
 * Until 2026-09-29 nothing checked contrast, and the page shipped control borders at 1.41:1 and
 * 1.35:1 against a 3:1 floor while every text pair passed: one token was doing a divider's job and
 * a control's. Opacity then took a read refusal's muted text to 2.59:1, which no token table can
 * see, so opacity on anything but an animation is refused outright rather than composited.
 */
export const colourPairs: Gate = {
  name: "every colour pair clears its floor",
  sees:
    "a pair below its floor in either theme, a token missing from one theme or named by no pair, a colour outside the tokens, and opacity outside an animation, in src/ui/app.html",
  blindTo:
    "a real pairing the list does not name, colour composed at runtime, and text over an image, which is why the shell smoke measures the rendered page",
  run(root) {
    const page = readAt(root, "src/ui/app.html");
    const style = page.slice(page.indexOf("<style>"), page.indexOf("</style>")).replace(/\/\*[\s\S]*?\*\//g, "");
    const light = /(^|\n)\s*:root\s*\{([^}]*)\}/.exec(style);
    const dark = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}\s*\}/.exec(style);
    if (!light || !dark) return ["src/ui/app.html must define its tokens in :root and again under prefers-color-scheme: dark"];
    const tokens = (block: string) => new Map([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1]!, m[2]!]));
    const themes = { light: tokens(light[2]!), dark: tokens(dark[1]!) };
    const out: string[] = [];

    for (const n of themes.light.keys()) if (!themes.dark.has(n)) out.push(`--${n} is defined for light and not for dark`);
    for (const n of themes.dark.keys()) if (!themes.light.has(n)) out.push(`--${n} is defined for dark and not for light`);
    const named = new Set(PAIRS.flatMap(([fg, bg]) => [fg, bg]));
    for (const n of themes.light.keys()) if (!named.has(n)) out.push(`--${n} is named by no pair, so nothing says what it sits on`);

    for (const [name, t] of Object.entries(themes)) {
      for (const [fg, bg, role, where] of PAIRS) {
        const a = t.get(fg);
        const b = t.get(bg);
        if (!a || !b) {
          out.push(`${name}: the pair ${fg} on ${bg} names a token that does not exist`);
          continue;
        }
        const r = contrast(a, b);
        if (r < FLOOR[role]) out.push(`${name}: --${fg} on --${bg} (${where}) is ${r.toFixed(2)}:1, under the ${role} floor of ${FLOOR[role]}`);
      }
    }

    // Everything outside the two token blocks: the rest of the stylesheet, and every style attribute.
    const rest = style.replace(light[0], "").replace(dark[0], "") + [...page.matchAll(/style="([^"]*)"/g)].map((m) => m[1]).join(";");
    for (const m of rest.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) out.push(`the colour ${m[0]} is outside the tokens, so no pair checks it`);
    const noKeyframes = rest.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, "");
    if (/\bopacity\s*:/.test(noKeyframes)) out.push("opacity outside an animation: it lowers text contrast below what the tokens say");
    return out;
  },
};

/**
 * The application never imports the harness, which is what makes "a probe is an instrument, never a
 * filter" a mechanism rather than a sentence.
 *
 * `npm run probes` mutates inputs whose effect is known and reports how the checks moved. The moment
 * anything under src/ can reach those relations, the temptation is one commit away and it looks like
 * an improvement: consult a probe while answering, drop a sentence a relation dislikes, refuse a
 * question that smells like a false premise. The measured reason not to, from published work on
 * questions with false premises: every method that improved accuracy on
 * questions with a false premise degraded it on questions with a true one, and about 13% of real
 * questions carry a false premise. It is invariant 9's rule in a second place. A screen is a
 * disclosure, an instrument measures, and neither one gets to decide what the person sees.
 *
 * The gate is broader than the rule on purpose: nothing the application is built from may import from
 * test/ at all. A narrower gate naming the probe files would pass the moment somebody renames one.
 */
export const harnessNotImported: Gate = {
  name: "the application never imports the harness",
  sees: "a file the application is built from importing anything under test/",
  blindTo:
    "a relation COPIED into src/ rather than imported, which is this gate's version of the marks " +
    "gate's blind spot, and a dynamic import built from a string at runtime",
  run(root) {
    const out: string[] = [];
    for (const f of sources(root)) {
      // scripts/ is walked by `sources` and is harness itself: the deletion pass and the proof runner
      // read test files on purpose, so they are named here rather than being an accident of the walk.
      if (f.rel.startsWith("scripts/")) continue;
      const m = f.text.match(/(?:from|require\()\s*['"][^'"]*\btest\/[^'"]*['"]/);
      if (m) out.push(`${f.rel} imports from test/ (${m[0].trim()}), so the application can reach the harness`);
    }
    return out;
  },
};

export const GATES: Gate[] = [
  harnessNotImported,
  forbiddenReference,
  noFallback,
  loopbackPinned,
  toolListEmpty,
  downloadIsolated,
  cloudIsolated,
  singleIntake,
  marksDoNotRank,
  bridgesFromTable,
  pageCallsTable,
  colourPairs,
];
