/**
 * The shell, driven for real: `npm run smoke`, which is `electron dist/test/shell-smoke.js`.
 *
 * It starts the real main process and the real page through the real bridge, with a throwaway
 * profile and a throwaway record, and asserts three things in order.
 *
 *   1. First run. With nothing remembered, the page offers the control that chooses a folder and
 *      hides everything that needs a record. The shell's first launch on 2026-09-28 showed a
 *      refusal and no control at all, and the old smoke passed it, because it asserted only that
 *      the bridge existed.
 *   2. A record opens. Once a confirmed folder is remembered, the page lists its documents.
 *   3. Contrast, focus and target size, MEASURED on the rendered page in both themes, at first
 *      run and again with a record open. The gate "every colour pair clears its floor" computes the
 *      palette; this reads what Chromium actually drew, and each pass proves itself by planting one
 *      element it knows fails and requiring the measurement to report it.
 *   4. Invariant 6 through the shell. A question carrying the nonce is typed into the question
 *      field, searched and then asked, and every byte of BOTH the profile and the record is read
 *      for it afterwards, with the control planted first. test/retention.test.ts reads a record
 *      folder the test made, which has never held Chromium's files; this reads them.
 *
 * It lives in test/ as its own Electron entry rather than as a mode of app/main.ts, so none of it
 * ships in the application.
 */
import { app, BrowserWindow, nativeTheme } from "electron";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmLocation, openRecord } from "../src/record/db.js";
import { intake } from "../src/ingest/intake.js";
import { rememberRecord } from "../src/ui/choose.js";
import { dataDirFor } from "../src/ui/folder.js";
import { isUp } from "../src/harness/runtime.js";
import { NAMES } from "../src/ui/api.js";
import { everyByteUnder, findNonce, NONCE } from "./fixtures.js";
import { RELEASES_URL } from "../src/download/update.js";

// Every request the main process makes to the release list, recorded from before the application
// loads, the way tools/watch-calls.mjs records calls: with the launch check off, which is the
// default, launch must make none (the updates plan's promise).
const releaseRequests: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  if (String(input instanceof Request ? input.url : input).startsWith(RELEASES_URL)) releaseRequests.push(String(input));
  return realFetch(input, init);
}) as typeof fetch;

const profile = mkdtempSync(join(tmpdir(), "pr-smoke-profile-"));
const recordDir = mkdtempSync(join(tmpdir(), "pr-smoke-record-"));
const packetDir = mkdtempSync(join(tmpdir(), "pr-smoke-packet-"));

await import("../app/main.js");
// After the import, because the shell sets its own profile folder as it loads and the last
// setPath before ready is the one Electron uses.
app.setPath("userData", profile);

const results: Array<{ ok: boolean; what: string }> = [];
const check = (ok: boolean, what: string) => results.push({ ok, what });
const notRun: string[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function page(): Promise<Electron.WebContents> {
  for (let i = 0; i < 100 && BrowserWindow.getAllWindows().length === 0; i++) await sleep(100);
  // The main window, never the Settings window, which is the same page at #settings.
  const wc = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().endsWith("#settings"))!.webContents;
  if (wc.isLoading()) await new Promise<void>((r) => wc.once("did-finish-load", () => r()));
  await sleep(800);
  return wc;
}

/**
 * Runs in the renderer. Every visible element with its own text is measured against the first
 * background behind it that is not transparent; every visible control's boundary (its fill when it
 * has one, else its border) against the ground it sits on. No compositing: the gate refuses opacity
 * outside an animation, so a background colour is the whole story.
 */
const MEASURE = `(() => {
  const rgb = (s) => { const m = /rgba?\\(([^)]+)\\)/.exec(s); if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(",").map(Number); return { r, g, b, a }; };
  const lum = ({ r, g, b }) => [r, g, b].map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
    .reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (x, y) => { const [h, l] = [lum(x), lum(y)].sort((a, b) => b - a); return (h + 0.05) / (l + 0.05); };
  const ground = (el) => { for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c && c.a > 0) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
  const visible = (el) => el.checkVisibility() && el.getBoundingClientRect().width > 0;
  const name = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + " " + JSON.stringify((el.textContent || el.placeholder || "").trim().slice(0, 30));
  const failures = [];
  let text = 0, controls = 0;
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el)) continue;
    if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) {
      text++;
      const r = ratio(rgb(getComputedStyle(el).color), ground(el));
      if (r < 4.5) failures.push("text " + name(el) + " " + r.toFixed(2) + ":1");
    }
    if (el.matches("button, input, textarea, select, summary")) {
      controls++;
      const s = getComputedStyle(el);
      // The boundary is whichever edge a person can see: the fill, where there is one, or the border.
      // The first version took an opaque fill as THE boundary, and reported the question field at
      // 1.04:1, its white fill on the near-white page, while its border drew the edge.
      const fill = rgb(s.backgroundColor);
      const border = rgb(s.borderTopColor);
      const bg = ground(el.parentElement);
      // A transparent border is no border. Until 2026-09-30 it was measured as the black its RGB
      // channels spell, so a borderless text button passed in light against black and failed in dark.
      // A control with neither a fill nor a border is identified by its text alone, which WCAG 1.4.11
      // does not require a boundary for, and its text is measured above.
      const edges = [fill && fill.a > 0 ? ratio(fill, bg) : null, border && border.a > 0 && parseFloat(s.borderTopWidth) > 0 ? ratio(border, bg) : null]
        .filter((x) => x !== null);
      const r = edges.length ? Math.max(...edges) : Infinity;
      if (r < 3) failures.push("control boundary " + name(el) + " " + r.toFixed(2) + ":1");
      const box = el.getBoundingClientRect();
      if (box.width < 24 || box.height < 24) failures.push("target " + name(el) + " " + Math.round(box.width) + "x" + Math.round(box.height));
    }
  }
  return { failures, text, controls };
})()`;

async function main(): Promise<number> {
  await app.whenReady();
  console.log("the shell is up; driving the page");
  let wc = await page();
  const js = <T>(code: string) => wc.executeJavaScript(code) as Promise<T>;

  /** Step 3, in both themes: measured contrast and size, then every Tab stop's focus ring. */
  const audit = async (where: string) => {
    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      await sleep(300);
      // The planted failure: divider-coloured text on a card, 1.41:1 in light by the palette.
      await js(`document.body.insertAdjacentHTML("afterbegin",
        '<div id="contrast-plant" class="sentence"><span style="color: var(--rule)">planted</span>' +
        '<button type="button" class="quiet" style="border-color: var(--rule)">plantedEdge</button></div>')`);
      const m = await js<{ failures: string[]; text: number; controls: number }>(MEASURE);
      await js(`document.getElementById("contrast-plant").remove()`);
      const planted = m.failures.filter((f) => f.includes('"planted"'));
      const edge = m.failures.filter((f) => f.includes('"plantedEdge"'));
      const real = m.failures.filter((f) => !f.includes('"planted"') && !f.includes('"plantedEdge"'));
      check(planted.length === 1, `${where}, ${theme}: control: a planted 1.41:1 text is reported, so the measurement can fire`);
      // Its edge is --rule, a divider colour: a control boundary under 3:1, which must be reported
      // now that a transparent border counts as no border rather than as black.
      check(edge.some((f) => f.startsWith("control boundary")), `${where}, ${theme}: control: a planted faint control edge is reported`);
      check(real.length === 0, `${where}, ${theme}: ${m.text} text elements and ${m.controls} controls measured, none under its floor or 24x24` +
        (real.length ? `: ${real.join("; ")}` : ""));

      // Real key events: a programmatic focus() need not trigger :focus-visible. And the page must
      // believe it has focus: without it Tab still moves focus and :focus-visible does not match,
      // so every ring reads as absent, which is a statement about the window, not the page. Asking
      // the operating system for focus worked at first run and failed after a long Ask, because
      // whatever the person is using meanwhile keeps it, so focus is EMULATED, which is exact.
      if (!wc.debugger.isAttached()) wc.debugger.attach();
      await wc.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
      wc.focus();
      await sleep(200);
      if (!(await js<boolean>(`document.hasFocus()`))) {
        check(false, `${where}, ${theme}: the window did not take keyboard focus, so focus rings were not measured`);
        continue;
      }
      /*
       * The walk is COUNT-INDEPENDENT since 2026-09-29, and the reason is a flake that was a true
       * positive about something.
       *
       * It used to count visible buttons and inputs and press Tab exactly that many times. One run
       * reported "nothing focused" on the light pass of the open-record screen while the dark pass of
       * the same screen passed, and it did not reproduce. A predicted count is a proxy for the
       * browser's real tab order, and the two disagree whenever an element is visible and not
       * focusable, or whenever the DOM changes between the count and the walk: the page reschedules
       * `showRuns` every 3 seconds while a run is live and every 20 otherwise, and it rebuilds a
       * section and toggles another's `hidden` when it fires.
       *
       * So the walk now Tabs until focus RETURNS to something it has already seen or leaves the
       * document, and reports what it found rather than checking it against a guess: which controls
       * Tab never reached (a real defect if any), and if focus vanishes, at which stop and how many
       * focusable elements existed at that moment. The mechanism of the original flake is still
       * unproven. This is the instrument that will name it.
       */
      // Identity is the element's INDEX among the page's controls, never its tag and id. Three buttons
      // on this page carry no id, so a "TAG#id" identity collides on all of them, and the walk broke
      // on a false repeat: it reported "4 Tab stops reached" out of nine and named three controls as
      // unreachable, differently in each theme, because a different starting point collides at a
      // different place. The tab order was a clean cycle of all nine the whole time. **An identity
      // that is not unique makes a walk report a subset as the whole**, and it looks like a finding
      // about the subject rather than about the instrument.
      const controls = await js<Array<{ at: number; label: string }>>(`[...document.querySelectorAll("button, input, textarea, select, summary")]
        .map((e, i) => ({ e, i }))
        // In the Tab order only: a tab list's other tabs are reached by arrow keys (tabindex -1), by
        // the WAI-ARIA pattern, and asserted separately below.
        .filter(({ e }) => e.checkVisibility() && getComputedStyle(e).visibility !== "hidden" && !e.disabled && e.tabIndex >= 0)
        .map(({ e, i }) => ({ at: i, label: e.tagName + "#" + (e.id || "no-id-" + i) }))`);
      await js(`document.activeElement && document.activeElement.blur()`);
      const rings: string[] = [];
      const reached: number[] = [];
      let vanished = "";
      // The budget is generous because a Tab press can be DROPPED: the two passes over this screen
      // reached complementary halves of the same seven controls, which a misordered walk cannot do and
      // a walk that sometimes does not move can. Presses that do not move focus are counted and
      // reported rather than absorbed.
      let stalled = 0;
      for (let i = 0; i < controls.length * 4 + 4; i++) {
        wc.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
        wc.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
        await sleep(60);
        const at = await js<number>(`(() => {
          const el = document.activeElement;
          if (!el || el === document.body || el === document.documentElement) return -1;
          return [...document.querySelectorAll("button, input, textarea, select, summary")].indexOf(el);
        })()`);
        if (at < 0) {
          // Focus left the document. That ends the tab order, and it is only a finding if it happened
          // before anything was reached or while controls remain unvisited: both are reported below.
          const now = await js<number>(`[...document.querySelectorAll("button, input, textarea, select, summary")]
            .filter((e) => e.checkVisibility() && getComputedStyle(e).visibility !== "hidden" && !e.disabled && e.tabIndex >= 0).length`);
          vanished = `focus left the document at stop ${i + 1} of ${controls.length}, ` +
            `with ${now} focusable control(s) present then and ${controls.length} counted before the walk`;
          break;
        }
        // Break on a COMPLETE cycle, not on any repeat. Blurring the active element does not reset
        // Chromium's sequential focus navigation starting point, so the walk begins wherever focus
        // last was and wraps around to the front. Breaking on any repeat therefore visited the tail
        // of the order and called it the whole thing: the first version of this reported "4 Tab
        // stops reached" out of seven controls, and WHICH four differed between the light and dark
        // passes because the steps before them differed. That is what the old count-based walk was
        // hiding, and it is a second true positive out of the same flake.
        if (at === reached[0] && reached.length > 1) break;
        if (reached.includes(at)) {
          stalled++;
          continue;
        }
        reached.push(at);
        rings.push(await js<string>(`(() => {
          const el = document.activeElement; if (!el || el === document.body) return "nothing focused";
          const s = getComputedStyle(el);
          if (s.outlineStyle === "none" || parseFloat(s.outlineWidth) < 1) return "no ring on " + el.tagName + "#" + el.id;
          ${MEASURE.slice(MEASURE.indexOf("const rgb"), MEASURE.indexOf("const visible"))}
          const r = ratio(rgb(s.outlineColor), ground(el.parentElement));
          return r < 3 ? "ring " + r.toFixed(2) + ":1 on " + el.tagName + "#" + el.id : "";
        })()`));
      }
      const badRings = rings.filter(Boolean);
      const missed = controls.filter((c) => !reached.includes(c.at)).map((c) => c.label);
      // Three findings, kept apart because they have different causes and different fixes: a control
      // keyboard cannot reach, a ring too faint to see, and focus leaving the page mid-walk.
      check(reached.length > 0 && badRings.length === 0 && missed.length === 0,
        `${where}, ${theme}: ${reached.length} Tab stops reached, each with a focus ring of 3:1 or more` +
        (badRings.length ? `: ${badRings.join("; ")}` : "") +
        (missed.length ? `: Tab never reached ${missed.join(", ")}` : "") +
        (reached.length === 0 ? ": Tab reached nothing at all" : "") +
        (missed.length && stalled ? ` (${stalled} press(es) did not move focus)` : ""));
      if (vanished && missed.length) check(false, `${where}, ${theme}: ${vanished}`);
    }
    nativeTheme.themeSource = "system";
  };

  // 1. First run.
  const first = await js<{ title: string; choose: boolean; needsHidden: boolean; bridge: string[]; leaked: string[] }>(`({
    title: document.title,
    choose: !document.getElementById("firstRun").hidden && !document.getElementById("chooseBtn").hidden,
    // Whether it is DRAWN, not whether the attribute is set: an element with its own display stays
    // on screen with hidden set, and asking the attribute passed that for a day.
    needsHidden: [...document.querySelectorAll(".needs-record")].every((el) => !el.checkVisibility()),
    bridge: Object.keys(window.record || {}).sort(),
    leaked: ["require", "process", "module", "global"].filter((k) => k in window),
  })`);
  check(first.title === "Bearing Diligence", `the window is titled Bearing Diligence: "${first.title}"`);
  check(first.choose, "first run: the page offers the control that chooses a folder");
  check(first.needsHidden, "first run: everything that needs a record is hidden");
  check(JSON.stringify(first.bridge) === JSON.stringify([...NAMES].sort()), `the bridge offers the table's names: ${first.bridge.join(", ")}`);
  check(first.leaked.length === 0, `nothing but the bridge reaches the page${first.leaked.length ? `: ${first.leaked.join(", ")}` : ""}`);
  await audit("first run");

  await sleep(1500);
  check(releaseRequests.length === 0, `launch with the update check off made no request to the release list${releaseRequests.length ? `: ${releaseRequests.length}` : ""}`);

  // 2. A record opens.
  confirmLocation(dataDirFor(recordDir), "the smoke");
  const packet = join(recordDir, "packet.txt");
  writeFileSync(
    packet,
    "Resolution 2026-07 authorises Contract PO-44821 in an amount not to exceed $1,200,000. " +
      "The motion carried on a vote of 5-2.\n",
  );
  mkdirSync(join(recordDir, "2026-09"));
  const second = join(recordDir, "2026-09", "second.txt");
  writeFileSync(second, "The reserve policy was amended to hold ninety days of operating costs.\n");
  const rec = openRecord(dataDirFor(recordDir));
  await intake(rec, packet, { layer: "public" });
  await intake(rec, second, { layer: "public" });
  rec.db.close();
  rememberRecord(profile, recordDir);
  wc.reload();
  wc = await page();
  const opened = await js<{ firstHidden: boolean; docs: string }>(`({
    firstHidden: document.getElementById("firstRun").hidden,
    docs: document.getElementById("docs").innerText,
  })`);
  check(opened.firstHidden && opened.docs.includes("packet.txt"), "a remembered, confirmed record opens and lists its document");

  // 3. The conversation.
  await sleep(800);
  const conv = await js<{ empty: boolean; thread: string; scope: string; drawer: boolean }>(`({
    empty: Boolean(document.querySelector("#thread .empty-state")),
    thread: document.getElementById("thread").innerText,
    scope: document.getElementById("scope").innerText,
    drawer: document.getElementById("side").checkVisibility(),
  })`);
  check(conv.empty && /Nothing you ask is saved/.test(conv.thread), "an empty conversation says that nothing asked is saved");
  check(!conv.drawer, "the documents are one click away, not always on screen");
  check(/^Asking all \d+ documents?\./.test(conv.scope), `the scope says what is searched: "${conv.scope}"`);
  const note = await js<string>(`document.getElementById("modelNote").innerText`);
  check(/on this computer\. Nothing you ask leaves it\./.test(note), `beside the question, where answers come from: "${note}"`);
  const counts = await js<{ docs: string; checks: string }>(`({
    docs: document.getElementById("docsBtn").textContent,
    checks: document.getElementById("checksBtn").textContent,
  })`);
  check(/^Documents · \d+$/.test(counts.docs), `the documents button is a count, with processing said inside: "${counts.docs}"`);
  check(counts.checks.trim() === "Source checks", `the header asks nothing of the person: no review count on "${counts.checks.trim()}"`);

  await js(`document.getElementById("docsBtn").click()`);
  await sleep(300);
  const drawer = await js<{ shown: boolean; group: boolean }>(`({
    shown: document.getElementById("side").checkVisibility(),
    group: [...document.querySelectorAll(".group-head")].some((g) => g.textContent.includes("2026-09")),
  })`);
  check(drawer.shown && drawer.group, "the Documents button opens the list, grouped by folder");
  // Show is one row of pills in the drawer, not a dropdown in a popover.
  const shown = await js<{ all: number; out: number; back: number; pressed: string }>(`(async () => {
    const rows = () => document.querySelectorAll("#docs button.row").length;
    const all = rows();
    document.querySelector('#showPills [data-show="out"]').click(); await new Promise((r) => setTimeout(r, 200));
    const out = rows(), pressed = document.querySelector('#showPills [aria-pressed="true"]').dataset.show;
    document.querySelector('#showPills [data-show="all"]').click(); await new Promise((r) => setTimeout(r, 200));
    return { all, out, back: rows(), pressed }; })()`);
  check(shown.all > 0 && shown.out === 0 && shown.back === shown.all && shown.pressed === "out",
    `the Left out pill filters the list and says it is chosen, All brings it back (${shown.all}, ${shown.out}, ${shown.back})`);
  await audit("the documents drawer");

  // A row's menu narrows the next question to that document, and the scope says so.
  await js(`[...document.querySelectorAll("#docs button.row")].find((b) => b.innerText.includes("packet.txt")).click()`);
  await sleep(300);
  await js(`document.querySelector('#rowMenu [data-act="only"]')?.click()`);
  await sleep(200);
  const scoped = await js<string>(`document.getElementById("scope").innerText`);
  check(/Asking only .*packet\.txt/.test(scoped), `"Ask only this document" narrows the scope, and it says so: "${scoped.replace(/\n/g, " ")}"`);
  const marked = await js<string>(`document.querySelector("#docs .rowwrap.scoped")?.innerText ?? ""`);
  check(/packet\.txt/.test(marked) && /only this/.test(marked), `the list marks the scoped document, agreeing with the chip: "${marked.replace(/\n/g, " ")}"`);
  await js(`document.getElementById("scopeAll").click(); document.getElementById("docsBtn").click()`);

  // The question box grows with a long question, and Shift and Return is a new line rather than a send.
  const box = await js<{ tag: string; grew: boolean; kept: boolean }>(`(() => {
    const q = document.getElementById("q"), h0 = q.offsetHeight;
    q.value = "one\\ntwo\\nthree\\nfour"; q.dispatchEvent(new Event("input"));
    const grew = q.offsetHeight > h0 + 20;
    q.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    const kept = q.value.includes("four");
    q.value = ""; q.dispatchEvent(new Event("input"));
    return { tag: q.tagName, grew, kept }; })()`);
  check(box.tag === "TEXTAREA" && box.grew && box.kept, `the question box grows with a long question and Shift and Return does not send (${JSON.stringify(box)})`);

  // 4. Invariant 6 through the shell.
  await js(`document.getElementById("q").focus()`);
  wc.insertText(`what was decided about ${NONCE} and the contract`);
  await js(`document.getElementById("searchBtn").click()`);
  await sleep(1500);
  const searched = await js<string>(`document.getElementById("thread").innerText`);
  check(searched.includes("PO-44821"), "search only added the packet's passage to the conversation");

  if (await isUp()) {
    await js(`document.getElementById("q").focus()`);
    wc.insertText(`what was decided about ${NONCE} and the contract`);
    await js(`document.getElementById("askForm").requestSubmit()`);
    let answered = "";
    for (let i = 0; i < 360; i++) {
      await sleep(500);
      answered = await js<string>(`document.getElementById("thread").lastElementChild.innerText`);
      if (answered && !answered.includes("reading the record")) break;
    }
    check(Boolean(answered) && !answered.includes("reading the record"), "ask added an answer or a stated failure to the conversation");
    // A kept sentence found its figures on the page; it is not thereby verified, and the page says so.
    const kept = await js<{ kept: number; told: number }>(`({
      kept: document.querySelectorAll("#thread .sentence.kept").length,
      told: [...document.querySelectorAll("#thread .sentence.kept")].filter((e) => /Source passage found\. Read it to confirm/.test(e.innerText)).length,
    })`);
    check(kept.told === kept.kept, `every kept sentence says its source was found, not that it is confirmed (${kept.told} of ${kept.kept})`);
    const answerSide = await js<{ dropped: number; labelled: number; cited: boolean; opened: boolean; active: boolean; moved: number }>(`(async () => {
      const dropped = [...document.querySelectorAll("#thread details.left-out .sentence.dropped")];
      // The citation under a searched passage: the same control as under a kept sentence, and there
      // whether or not the model is up.
      const cite = document.querySelector("#thread button.citebtn");
      let opened = false, active = false, moved = 0;
      if (cite) {
        const before = cite.getBoundingClientRect().top;
        cite.click();
        await new Promise((r) => setTimeout(r, 900));
        opened = !document.getElementById("source").hidden && Boolean(document.getElementById("sourceMark"));
        active = cite.classList.contains("active");
        moved = Math.abs(cite.getBoundingClientRect().top - before);
        document.getElementById("sourceClose").click();
      }
      return { dropped: dropped.length, labelled: dropped.filter((d) => /^left out/i.test(d.textContent.trim())).length, cited: Boolean(cite), opened, active, moved };
    })()`);
    check(answerSide.labelled === answerSide.dropped, `every left-out sentence starts with its label (${answerSide.labelled} of ${answerSide.dropped})`);
    check(answerSide.cited && answerSide.opened && answerSide.active && answerSide.moved < 40,
      `a citation opens its page with the passage marked, marks itself, and stays in place (moved ${Math.round(answerSide.moved)}px)`);
  } else {
    notRun.push("ask through the shell: the model runtime is not answering on 127.0.0.1:1948");
  }
  await audit("the conversation, with an answer");

  // One statement set aside for a near copy of its page, as most refusals on real agendas were, so the
  // source-check path runs whether or not the model is up. Seeded now rather than at setup: the app
  // reads its documents again when a folder opens, and a re-read replaces that document's refusals.
  {
    const seed = openRecord(dataDirFor(recordDir));
    seed.db.prepare(
      "INSERT INTO ledger (document_id, window_no, claim_text, quote, verdict, reason, created_at) VALUES ((SELECT id FROM documents WHERE filename = 'packet.txt'), 1, ?, ?, 'absent', 'the span is not in the source', ?)",
    ).run("The contract may not exceed $1,200,000.", "authorises Contract PO-44821 in an amount not exceeding $1,200,000", new Date().toISOString());
    seed.db.close();
  }
  await js(`document.getElementById("checksBtn").click()`);
  await sleep(800);
  await audit("the checks drawer");
  // A check is judged beside its page: the closest text is marked, and the question is one a person
  // can answer, with Not sure as an answer.
  const judge = await js<{ pane: string; count: string; opened: boolean; marked: string; buttons: string[] }>(`(async () => {
    const pane = document.querySelector('#sideSwitch [aria-pressed="true"]').dataset.pane, count = document.getElementById("checksCount").textContent;
    [...document.querySelectorAll("#refusals [data-open-ref]")].find((b) => b.innerText.includes("may not exceed"))?.click();
    await new Promise((r) => setTimeout(r, 800));
    return { pane, count, opened: !document.getElementById("source").hidden, marked: document.getElementById("sourceMark")?.textContent || "",
      buttons: [...document.querySelectorAll("#sourceJudge [data-judge]")].map((b) => b.textContent.trim()) }; })()`);
  check(judge.pane === "checks" && /^[1-9]\d* open$/.test(judge.count), `the sidebar shows Source checks with its count inside it: ${judge.pane}, "${judge.count}"`);
  check(judge.opened && /PO-44821/.test(judge.marked) && judge.buttons.join("|") === "It is on the page|It is not on the page|Not sure",
    `a check opens its page with the closest text marked and three answers: "${judge.marked}", ${judge.buttons.join(", ")}`);
  await audit("a source check beside its page");
  const unsure = await js<{ found: boolean; count: string }>(`(async () => {
    if (!document.querySelector('#sourceJudge [data-judge="skip"]')) {
      [...document.querySelectorAll("#refusals [data-open-ref]")].find((b) => b.innerText.includes("may not exceed"))?.click();
      await new Promise((r) => setTimeout(r, 800));
    }
    const b = document.querySelector('#sourceJudge [data-judge="skip"]');
    b?.click();
    await new Promise((r) => setTimeout(r, 800));
    return { found: Boolean(b), count: document.getElementById("checksCount").textContent }; })()`);
  check(unsure.found && unsure.count === judge.count, `Not sure records nothing: the check stays open ("${unsure.count}")`);
  await js(`document.getElementById("checksBtn").click()`);

  // The folder switcher does one job: folders, and opening one.
  await js(`document.getElementById("where").click()`);
  await sleep(300);
  const menuItems = await js<string>(`document.getElementById("folderMenu").innerText`);
  check(/Open a folder/.test(menuItems) && !/Settings/.test(menuItems), `the folder switcher holds folders and "Open a folder", not Settings: "${menuItems.replace(/\n/g, " | ")}"`);
  await js(`document.getElementById("where").click()`);

  // Settings is its own window, the same page at #settings, opened from its button at the right.
  await js(`document.getElementById("settingsBtn").click()`);
  let settings: Electron.BrowserWindow | undefined;
  for (let i = 0; i < 50 && !settings; i++) {
    await sleep(100);
    settings = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("#settings"));
  }
  check(Boolean(settings), "the Settings button opens Settings in its own window");
  if (settings) {
    const main = wc;
    wc = settings.webContents;
    if (wc.isLoading()) await new Promise<void>((r) => wc.once("did-finish-load", () => r()));
    await sleep(1500);
    const st = await js<{ text: string; save: string | null; role: string | null }>(`({
      text: document.getElementById("settingsView").innerText,
      save: document.getElementById("saveAllToggle").getAttribute("aria-checked"),
      role: document.getElementById("saveAllToggle").getAttribute("role") })`);
    check(/Automatically save conversations/.test(st.text) && st.role === "switch" && st.save === "false" && /The app/.test(st.text),
      "Settings shows this folder's saving as a switch, off by default, and the app");
    // The switch's words toggle it too, and it says so to a screen reader; then it is put back off.
    await js(`document.querySelector('label[for="saveAllToggle"]').click()`);
    await sleep(400);
    const flipped = await js<string | null>(`document.getElementById("saveAllToggle").getAttribute("aria-checked")`);
    check(flipped === "true", `clicking the switch's label turns saving on: aria-checked=${flipped}`);
    await js(`document.getElementById("saveAllToggle").click()`);
    await sleep(400);
    // The folder reads as a Mac shows it, and deleting a saved conversation asks first (it compacts the
    // file, so nothing could undo it), with Cancel focused; Cancel keeps it, Delete removes it.
    await js(`api.saveConversation([{ question: "a smoke question", asked_at: new Date().toISOString(), answer: null }]).then(async () => renderSettings(await api.state()))`);
    await sleep(800);
    const del1 = await js<{ path: string; finder: boolean; asks: string; focus: string; left: number }>(`(() => {
      document.querySelector("#savedList [data-del]").click();
      return { path: document.querySelector("#settingsView .path").innerText, finder: Boolean(document.getElementById("openFolder")),
        asks: document.querySelector("#savedList .confirm")?.innerText || "", focus: document.activeElement?.textContent || "",
        left: document.querySelectorAll("#savedList [data-del]").length }; })()`);
    check(!/\/Users\//.test(del1.path) && del1.finder, `the folder is shown as ~/..., with Show in Finder: "${del1.path.replace(/\n/g, " ")}"`);
    check(/cannot be recovered/.test(del1.asks) && del1.focus.trim() === "Cancel" && del1.left === 0,
      `Delete asks first, in place, with Cancel focused: "${del1.asks.replace(/\n/g, " ")}", focus "${del1.focus.trim()}"`);
    await js(`document.querySelector("#savedList [data-del-no]").click()`);
    await sleep(600);
    const kept = await js<number>(`document.querySelectorAll("#savedList [data-del]").length`);
    await js(`document.querySelector("#savedList [data-del]").click(); document.querySelector("#savedList [data-del-yes]").click()`);
    await sleep(800);
    const gone = await js<number>(`api.conversations().then((c) => c.conversations.length)`);
    check(kept === 1 && gone === 0, `Cancel keeps the conversation (${kept}), Delete removes it (${gone} left)`);
    // The answering model. The cloud is reached only through a confirmation, nothing is stored by
    // asking, and a key is kept only encrypted: a stand-in key, written by this test, is searched for
    // in plain text across every byte of the profile the way the question is.
    const STANDIN = "sk-or-stand-in-for-the-smoke-not-a-key-0000";
    const model = await js<{ local: boolean; asks: string; stored: string; keyInput: boolean }>(`(async () => {
      const wait = () => new Promise((r) => setTimeout(r, 700));
      await wait();
      const local = document.querySelector('#modelWhere [data-where="local"]')?.getAttribute("aria-pressed") === "true";
      document.querySelector('#modelWhere [data-where="cloud"]').click(); await wait();
      const asks = document.querySelector("#modelSection .confirm-cloud")?.innerText || "";
      const stored = (await api.modelSettings()).choice.where;
      document.querySelector('#modelSection [data-cloud="yes"]').click(); await wait();
      return { local, asks, stored, keyInput: Boolean(document.getElementById("cloudKey")) };
    })()`);
    check(model.local && /leave this computer/.test(model.asks) && model.stored === "local",
      `choosing the cloud first says what leaves, and stores nothing: "${model.asks.split("\n")[0]}", stored ${model.stored}`);
    check(model.keyInput, "after confirming, the cloud asks for a key before anything can be sent");
    const saved = await js<boolean>(`(async () => {
      document.getElementById("cloudKey").value = ${JSON.stringify(STANDIN)};
      document.querySelector('#modelSection [data-key="save"]').click();
      await new Promise((r) => setTimeout(r, 700));
      return (await api.modelSettings()).cloud.keySaved; })()`);
    const planted = join(profile, "control-key.txt");
    writeFileSync(planted, STANDIN);
    check(everyByteUnder(profile).some((f) => f.path === planted), "control: a key planted in plain text in the profile is found, so the search can fire");
    unlinkSync(planted);
    const plain = everyByteUnder(profile).filter((f) => f.bytes.includes(STANDIN)).map((f) => f.path);
    check(saved && plain.length === 0, `the key is saved only encrypted: ${saved ? "saved" : "NOT saved"}, found in plain text in ${plain.length ? plain.join(", ") : "no file"}`);
    const removed = await js<boolean>(`(async () => {
      document.querySelector('#modelSection [data-key="forget"]').click();
      await new Promise((r) => setTimeout(r, 700));
      return (await api.modelSettings()).cloud.keySaved; })()`);
    check(!removed, "Remove takes the key off the computer");
    await audit("Settings");
    // Appearance: choosing Dark here turns the OTHER window dark, and Match the Mac hands it back.
    await js(`document.querySelector('[data-appearance="dark"]').click()`);
    await sleep(500);
    const darkThere = await main.executeJavaScript(`matchMedia("(prefers-color-scheme: dark)").matches`);
    const pressed = await js<string>(`document.querySelector('[aria-pressed="true"][data-appearance]')?.dataset.appearance || ""`);
    check(darkThere && pressed === "dark" && nativeTheme.themeSource === "dark", "choosing Dark in Settings turns the main window dark, and says which is chosen");
    await js(`document.querySelector('[data-appearance="system"]').click()`);
    await sleep(300);
    check(nativeTheme.themeSource === "system", "Match the Mac hands the appearance back to the Mac");
    settings.destroy();
    wc = main;
  }

  // Leaving a document out: at once, focus to the next row, and Undo brings it back.
  await js(`document.getElementById("docsBtn").click()`);
  await sleep(300);
  const openSecond = `[...document.querySelectorAll("#docs button.row")].find((b) => b.innerText.includes("second.txt")).click()`;
  await js(openSecond);
  await sleep(200);
  // The row is being read at most for the few seconds a one-line file takes; wait that out, because
  // a document being read offers no Leave out, by design.
  for (let i = 0; i < 60 && !(await js<boolean>(`Boolean(document.querySelector('#rowMenu [data-act="out"]'))`)); i++) {
    await sleep(500);
    await js(openSecond);
  }
  await js(`document.querySelector('#rowMenu [data-act="out"]')?.click()`);
  await sleep(2000);
  const left = await js<{ focusRow: boolean; undo: boolean; state: string }>(`({
    focusRow: document.activeElement && document.activeElement.matches("#docs button.row"),
    undo: Boolean(document.getElementById("undoBtn")),
    state: [...document.querySelectorAll("#docs button.row")].find((b) => b.innerText.includes("second.txt"))?.innerText || "",
  })`);
  check(left.focusRow && left.undo && /excluded/.test(left.state), `leaving out moves focus to a row and offers Undo: "${left.state.replace(/\n/g, " ")}"`);
  await js(`document.getElementById("undoBtn").click()`);
  await sleep(1500);
  const back = await js<string>(`[...document.querySelectorAll("#docs button.row")].find((b) => b.innerText.includes("second.txt"))?.innerText || ""`);
  check(Boolean(back) && !/excluded/.test(back), `Undo includes it again: "${back.replace(/\n/g, " ")}"`);
  await js(`document.getElementById("docsBtn").click()`);

  // New conversation empties the thread back to what is new.
  await js(`document.getElementById("newConv").click()`);
  await sleep(600);
  const emptied = await js<boolean>(`Boolean(document.querySelector("#thread .empty-state")) && !document.getElementById("thread").innerText.includes("PO-44821 in an amount")`);
  check(emptied, "New conversation empties the thread");

  // A phone-width window: the drawer, when open, covers the conversation rather than squeezing it.
  const win = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().endsWith("#settings"))!;
  const [w0, h0] = win.getSize();
  win.setSize(375, 812);
  await sleep(600);
  await audit("375px wide");
  // Contrast and targets say nothing about fit: a header that would not wrap pushed the page to 423px
  // here and clipped Settings off the edge while every audit passed.
  const fit = await js<{ page: number; win: number; wide: string[] }>(`(() => { const W = document.documentElement.clientWidth;
    return { page: document.documentElement.scrollWidth, win: W, wide: [...document.querySelectorAll("body *")]
      .filter((e) => e.checkVisibility() && e.getBoundingClientRect().right > W + 1).map((e) => e.id || e.className).slice(0, 5) }; })()`);
  check(fit.page <= fit.win, `at 375px nothing is wider than the window (page ${fit.page}px in ${fit.win}px${fit.wide.length ? ": " + fit.wide.join(", ") : ""})`);
  await js(`document.getElementById("docsBtn").click()`);
  await sleep(300);
  const narrow = await js<{ side: boolean; content: boolean }>(`({
    side: document.getElementById("side").checkVisibility(),
    content: document.getElementById("content").checkVisibility() })`);
  check(narrow.side && !narrow.content, "at 375px the open drawer covers the conversation");
  await audit("375px wide, drawer open");
  await js(`document.getElementById("docsBtn").click()`);
  win.setSize(w0!, h0!);
  await sleep(400);

  await wc.session.flushStorageData();

  const control = join(profile, "planted-control.txt");
  writeFileSync(control, `a question about ${NONCE}`);
  check(findNonce(profile).includes(control), "control: the nonce planted in the profile is found, so the search can fire");
  unlinkSync(control);

  const hits = [...findNonce(profile), ...findNonce(recordDir)];
  check(hits.length === 0, `invariant 6: the question reached no file in the profile or the record${hits.length ? `: ${hits.join(", ")}` : ""}`);

  for (const r of results) console.log(`${r.ok ? "pass" : "FAIL"}  ${r.what}`);
  console.log(
    "\ncannot see: macOS text services other than the spell checker (which is off), crash reports, " +
      "input typed with real keystrokes rather than inserted text, and anything written after the process exits",
  );
  const failed = results.filter((r) => !r.ok).length;
  if (notRun.length) {
    console.log(`\n${notRun.length} check(s) DID NOT RUN:`);
    for (const n of notRun) console.log(`  ${n}`);
    if (process.env.SKIPS_OK !== "1") {
      console.log("Fix the precondition, or run with SKIPS_OK=1 to say you meant it.");
      return 1;
    }
  }
  return failed ? 1 : 0;
}

// NOT awaited at the top level. Electron emits "ready" only once the entry module has finished
// evaluating, so a top-level await on anything that waits for ready never returns: the first
// version of this file did exactly that and sat silent until it was killed.
void main()
  .catch((e: Error) => {
    // What was checked before the stop is where the stop is: without it, a thrown step printed only
    // the renderer's generic error and every result before it was lost.
    for (const r of results) console.log(`${r.ok ? "pass" : "FAIL"}  ${r.what}`);
    console.error(`the smoke stopped after ${results.length} checks: ${e.stack}`);
    return 1;
  })
  .then(async (code) => {
    // The exit code is the checks' result whatever the cleanup does. Until 2026-09-29 the folders
    // were removed first and the exit came after, and Chromium was still writing into the profile
    // while it was being removed: the removal threw, the exit was never reached, and a smoke with a
    // FAILED check ended with 0. Found by planting the old window title and watching it "pass".
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
    await sleep(300);
    for (const d of [profile, recordDir, packetDir]) {
      try {
        rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (e) {
        console.log(`note: could not remove ${d} (${(e as Error).message}); it is in the system temporary folder`);
      }
    }
    app.exit(code);
  });
