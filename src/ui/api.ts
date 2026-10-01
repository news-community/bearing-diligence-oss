/**
 * Everything the page can ask of the record, in ONE table.
 *
 * The page reaches the record through a bridge, and there are two bridges: `app/preload.cjs` in the
 * shipped shell and the development server's injected `window.record`. Until 2026-09-28 each
 * implemented every method by hand, a documents query was copied verbatim between them, and a gate
 * existed only to keep the two lists equal. Both are now built from this table's names, so they
 * cannot differ, and the gate over them checks that neither grows a hand-written method.
 *
 * A second gate reads this table against the page: every name here must be called by the page and
 * every call must be a name here. Four methods were offered and never called, including choosing a
 * folder and adding a document, which left the shell able to do nothing but refuse.
 *
 * Two entries open native dialogs and so exist only in the shell. They are marked `shellOnly` with
 * the sentence a browser shows instead; the shell supplies them and refuses to start if one is
 * missing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LocationRefused, type Record as OpenRecord } from "../record/db.js";
import { MARKER } from "../util/paths.js";
import { answer } from "../answer/answer.js";
import { retrieve } from "../answer/retrieve.js";
import { computeChangeRecord } from "../change/compare.js";
import { groupChanges } from "../change/group.js";
import { planWindows } from "../ingest/pipeline.js";
import { nearest } from "../quote/locator.js";
import { subjectLabel } from "../change/label.js";
import { buildBrief, renderBrief } from "../brief/brief.js";
import { describeRuns } from "../record/runs.js";
import { listRefusals, review, summarise } from "../quote/refusals.js";
import { listMarks } from "../screen/marks.js";
import { identify, isUp, startRuntime } from "../harness/runtime.js";
import { GENERAL_MODEL } from "../harness/model.js";
import { askerFor, CLOUD, listCloudModels, type ModelChoice } from "../harness/choose.js";
import { modelChoice, setModelChoice } from "../record/model-choice.js";
import { bestLocal, localModels, type LocalModel } from "./models.js";
import { modelStates } from "../download/pull.js";
import type { IntakeQueue } from "../ingest/queue.js";
import { digestOf, fileIn, listFolder, readFolder } from "./folder.js";
import { documentLabel } from "./doc-label.js";
import {
  deleteConversation, getConversation, listConversations, saveConversation, savesConversations, setSavesConversations,
  type Turn,
} from "../record/conversations.js";
import { whatsNew } from "./whats-new.js";
import { includeAgain, leaveOut } from "../record/remove.js";
import { checkForUpdate } from "./updates.js";

/**
 * What a handler is given. `dir` is the folder the person opened, whose documents are read; the record's
 * own data is in `dataDirFor(dir)` (src/ui/folder.ts). `record()` throws when there is no folder or it is refused.
 */
export type Ctx = {
  dir: string | null;
  /** When this folder was opened before this time, or null the first time: what "new" means. */
  since: string | null;
  /** The running application's version. */
  version: string;
  record(): OpenRecord;
  intake: IntakeQueue;
  /**
   * The saved cloud key, decrypted for one call, or null when none is saved. Only the desktop
   * application has one: it lives in the app's profile, encrypted by the operating system's keychain.
   * The development server has no profile and passes nothing.
   */
  cloudKey?: () => string | null;
};

/** The folder's choice of answering model, with the default local model filled in (src/ui/models.ts). */
async function choiceFor(ctx: Ctx): Promise<ModelChoice> {
  let fallbackName = GENERAL_MODEL;
  try { fallbackName = bestLocal(await localModels()); } catch { /* the runtime is down: the reading model is the default */ }
  return modelChoice(ctx.record(), fallbackName);
}

export class NoRecord extends Error {
  constructor() {
    super("No folder has been opened yet.");
    this.name = "NoRecord";
  }
}

// Handlers are typed loosely at the boundary on purpose: the arguments arrive over IPC or HTTP as
// JSON, so a signature here would be a claim about data nothing has checked. Each handler checks
// what it needs.
export type Run = (ctx: Ctx, ...args: any[]) => unknown;
export type Handler = { run: Run } | { shellOnly: string };

const documentsOf = (r: OpenRecord) =>
  r.db
    .prepare(
      `SELECT d.id, d.filename, d.layer, d.meeting, d.page_count, d.added_at,
              c.pages_with_text, c.windows_total, c.windows_completed, c.windows_failed,
              (SELECT COUNT(*) FROM claims WHERE document_id = d.id) AS claims,
              (SELECT COUNT(*) FROM ledger WHERE document_id = d.id) AS refused,
              (SELECT COUNT(*) FROM votes WHERE document_id = d.id) AS votes,
              (SELECT COUNT(*) FROM changes ch JOIN change_records cr ON cr.id = ch.change_record_id
                WHERE cr.document_id = d.id) AS changes,
              (SELECT substr(text, 1, 400) FROM pages WHERE document_id = d.id AND page_no = 1) AS first_page
         FROM documents d LEFT JOIN coverage c ON c.document_id = d.id
        ORDER BY d.added_at DESC`,
    )
    .all()
    .map((row) => {
      const { first_page, ...d } = row as { first_page: string | null; filename: string } & Record<string, unknown>;
      return { ...d, label: documentLabel(d.filename, first_page).label };
    });

type PageRow = { id: number; document_id: number; filename: string; page_no: number; text: string };
const PAGE_SQL = "SELECT p.id, p.document_id, d.filename, p.page_no, p.text FROM pages p JOIN documents d ON d.id = p.document_id";

/** Earlier turns from the page, checked at the boundary: questions and answers as text. */
const turnsOf = (v: unknown): Array<{ question: string; answer: string }> =>
  Array.isArray(v)
    ? v.filter((t) => t && typeof t.question === "string" && typeof t.answer === "string")
        .map((t) => ({ question: String(t.question), answer: String(t.answer) }))
    : [];

/** A conversation to save, from the page: each turn a question, when it was asked, and its answer. */
const turnsToSave = (v: unknown): Turn[] => {
  if (!Array.isArray(v)) throw new Error("a conversation is a list of turns");
  return v.map((t) => {
    if (!t || typeof t.question !== "string" || typeof t.asked_at !== "string") throw new Error("a turn needs a question and a time");
    return { question: t.question, asked_at: t.asked_at, answer: t.answer ?? null };
  });
};

const id = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`not a document id: ${String(v)}`);
  return n;
};

const text = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${what} is required`);
  return v;
};

export const API = {
  /** Whether there is a record, and if there is not, why: no folder chosen, or the folder refused. */
  state: {
    run: (ctx: Ctx) => {
      if (!ctx.dir) return { ok: false, first_run: true, message: new NoRecord().message };
      try {
        const r = ctx.record();
        return { ok: true, dir: ctx.dir, model: GENERAL_MODEL, documents: documentsOf(r), queue: ctx.intake.state() };
      } catch (e) {
        if (e instanceof LocationRefused) {
          // A remembered folder that was never opened this way is simply not open yet.
          const unconfirmed = e.verdict.refusals.every((r) => r.startsWith(`no ${MARKER}`));
          if (unconfirmed) return { ok: false, first_run: true, message: new NoRecord().message };
          return { ok: false, first_run: false, dir: ctx.dir, verdict: e.verdict };
        }
        throw e;
      }
    },
  },
  /** `scope` is a document id to ask only that document, or absent to ask them all. */
  ask: {
    run: async (ctx: Ctx, q: unknown, scope?: unknown, earlier?: unknown) => {
      const question = text(q, "a question");
      // The same as the command line: a question with the runtime down would otherwise come back
      // as an unreachable failure the first time a question is asked after launching.
      const choice = await choiceFor(ctx);
      if (choice.where === "local" && !(await isUp())) await startRuntime();
      return answer(ctx.record().db, question, {
        model: choice.model,
        via: choice.where,
        asker: askerFor(choice, { cloudKey: choice.where === "cloud" ? (ctx.cloudKey?.() ?? "") : "" }),
        documentId: scope == null ? undefined : id(scope),
        earlier: turnsOf(earlier),
      });
    },
  },
  /** The folder's documents and where each one is; queues any not yet read. */
  folder: { run: (ctx: Ctx) => readFolder(ctx.dir ?? "", ctx.record(), ctx.intake) },
  /**
   * Leave a document out: everything read from it is removed and it is not read again. `target` is
   * a file's name in the folder, or `{ document }` for one listed as no longer in the folder.
   */
  leaveOut: {
    run: (ctx: Ctx, target: unknown) => {
      const rec = ctx.record();
      if (target && typeof target === "object" && "document" in target) {
        const row = rec.db.prepare<[number], { digest: string }>("SELECT digest FROM documents WHERE id = ?").get(id((target as { document: unknown }).document));
        if (!row) throw new Error("that document is not in the record");
        leaveOut(rec, row.digest);
        return readFolder(ctx.dir ?? "", rec, ctx.intake);
      }
      const f = fileIn(listFolder(ctx.dir ?? "", rec, ctx.intake.state()), target);
      if (f.state === "reading") throw new Error(`${f.name} is being read now. Leave it out when it finishes.`);
      ctx.intake.remove(f.path);
      const digest = digestOf(f.path);
      if (!digest) throw new Error(`${f.name} could not be opened`);
      leaveOut(rec, digest);
      return readFolder(ctx.dir ?? "", rec, ctx.intake);
    },
  },
  /** Let a left-out file back in; it is read again from scratch. */
  includeAgain: {
    run: (ctx: Ctx, name: unknown) => {
      const rec = ctx.record();
      const digest = digestOf(fileIn(listFolder(ctx.dir ?? "", rec, ctx.intake.state()), name).path);
      if (digest) includeAgain(rec, digest);
      return readFolder(ctx.dir ?? "", rec, ctx.intake);
    },
  },
  /**
   * What is new in this folder since it was last opened: the documents added and what their change
   * records found, and questions built from those changes. Built by code from the record; nothing
   * asked before exists to build from.
   */
  whatsNew: { run: (ctx: Ctx) => whatsNew(ctx.record(), ctx.since) },
  /** Saved conversations in this folder (invariant 6). */
  conversations: {
    run: (ctx: Ctx) => ({ saveAll: savesConversations(ctx.record()), conversations: listConversations(ctx.record()) }),
  },
  conversation: { run: (ctx: Ctx, cid: unknown) => getConversation(ctx.record(), id(cid)) },
  saveConversation: {
    run: (ctx: Ctx, turns: unknown, cid?: unknown) => ({
      id: saveConversation(ctx.record(), turnsToSave(turns), cid == null ? undefined : id(cid)),
    }),
  },
  deleteConversation: {
    run: (ctx: Ctx, cid: unknown) => {
      deleteConversation(ctx.record(), id(cid));
      return { ok: true };
    },
  },
  /** Save every conversation in this folder automatically, or not. Off by default. */
  saveAll: {
    run: (ctx: Ctx, on?: unknown) => {
      if (typeof on === "boolean") setSavesConversations(ctx.record(), on);
      return { saveAll: savesConversations(ctx.record()) };
    },
  },
  search: {
    run: (ctx: Ctx, q: unknown, scope?: unknown) => ({
      passages: retrieve(ctx.record().db, text(q, "a search"), 10, scope == null ? undefined : id(scope)),
    }),
  },
  /**
   * One whole page, for the source pane: by a citation's id (`p123`, the page's own id), or by
   * `{ document, page }` for a change record's then and now passages.
   */
  page: {
    run: (ctx: Ctx, ref: unknown) => {
      const db = ctx.record().db;
      const row =
        typeof ref === "string" && /^p\d+$/.test(ref)
          ? db.prepare<[number], PageRow>(PAGE_SQL + " WHERE p.id = ?").get(Number(ref.slice(1)))
          : ref && typeof ref === "object" && "document" in ref && "page" in ref
            ? db.prepare<[number, number], PageRow>(PAGE_SQL + " WHERE p.document_id = ? AND p.page_no = ?")
                .get(id((ref as { document: unknown }).document), id((ref as { page: unknown }).page))
            : undefined;
      if (!row) throw new Error("that page is not in the record");
      return row;
    },
  },
  change: {
    run: (ctx: Ctx, doc: unknown) => {
      const c = computeChangeRecord(ctx.record().db, id(doc));
      // One comparison per passage pair (src/change/group.ts), each document named as a person reads it.
      const labels = new Map<number, string>();
      const name = (d: number | null) => {
        if (d == null) return "";
        if (!labels.has(d)) {
          const r = ctx.record().db
            .prepare<[number], { filename: string; first_page: string | null }>(
              "SELECT filename, (SELECT substr(text, 1, 400) FROM pages WHERE document_id = d.id AND page_no = 1) AS first_page FROM documents d WHERE id = ?",
            )
            .get(d);
          labels.set(d, r ? documentLabel(r.filename, r.first_page).label : "");
        }
        return labels.get(d)!;
      };
      return {
        ...c,
        changes: groupChanges(c.changes).map((ch) => ({
          ...ch, label: subjectLabel(ch.subject), then_document: name(ch.then_document_id), now_document: name(ch.now_document_id),
        })),
      };
    },
  },
  brief: { run: (ctx: Ctx, doc: unknown) => ({ text: renderBrief(buildBrief(ctx.record().db, id(doc))) }) },
  runs: { run: (ctx: Ctx) => ({ runs: describeRuns(ctx.record().db) }) },
  // Invariant 9's marks. Read here and nowhere else: a mark is a disclosure to the reader and changes
  // nothing about what the record retrieves or how it ranks (src/gates/gates.ts, "a mark changes
  // nothing").
  marks: { run: (ctx: Ctx, doc?: unknown) => ({ marks: listMarks(ctx.record().db, doc == null ? undefined : id(doc)) }) },
  refusals: {
    run: (ctx: Ctx, doc?: unknown) => {
      const d = doc == null ? undefined : id(doc);
      return { summary: summarise(ctx.record().db, d), refusals: listRefusals(ctx.record().db, d, false, 40) };
    },
  },
  /**
   * Where a refused quote comes closest in its document, for the person judging it: the refusal's
   * window is rebuilt from its pages by the same planner that read it, and the page whose text
   * shares most of the quote's words is returned with that stretch. A pointer, never a verdict.
   */
  refusalSource: {
    run: (ctx: Ctx, refusal: unknown) => {
      const db = ctx.record().db;
      const r = db
        .prepare<[number], { document_id: number; window_no: number; quote: string }>("SELECT document_id, window_no, quote FROM ledger WHERE id = ?")
        .get(id(refusal));
      if (!r) throw new Error("that check is no longer in the record");
      const pages = db
        .prepare<[number], { page_no: number; text: string; has_text_layer: number }>(
          "SELECT page_no, text, has_text_layer FROM pages WHERE document_id = ? ORDER BY page_no",
        )
        .all(r.document_id);
      const w = planWindows(pages).find((x) => x.window_no === r.window_no);
      let best: { page_no: number; start: number; end: number; shared: number } | null = null;
      for (const p of pages) {
        if (w && !w.pages.includes(p.page_no)) continue;
        const hit = r.quote ? nearest(r.quote, p.text) : null;
        if (hit && (!best || hit.shared > best.shared)) best = { page_no: p.page_no, ...hit };
      }
      return { document_id: r.document_id, page_no: best?.page_no ?? w?.page_from ?? 1, start: best?.start ?? -1, end: best?.end ?? -1, shared: best?.shared ?? 0 };
    },
  },
  review: {
    run: (ctx: Ctx, refusal: unknown, verdict: unknown, note?: unknown) => {
      if (verdict !== "right" && verdict !== "wrong") throw new Error("a verdict is right or wrong");
      review(ctx.record().db, id(refusal), verdict, typeof note === "string" ? note : "");
      return { ok: true, summary: summarise(ctx.record().db) };
    },
  },
  /**
   * "This record": facts the code already computes, gathered in one place. It has no switches,
   * because what a settings page usually holds (an account, a sync target, a provider, updates,
   * telemetry) is absent by design (docs/design.md, invariant 7).
   */
  about: {
    run: async (ctx: Ctx) => {
      const r = ctx.record();
      const confirmed = JSON.parse(readFileSync(join(r.verdict.dir, MARKER), "utf8")) as Record<string, string>;
      const runtime = await identify();
      const models = runtime.answering && runtime.speaks_the_protocol ? await modelStates() : null;
      return { dir: r.verdict.dir, confirmed, verdict: r.verdict, runtime, models, model: GENERAL_MODEL, version: ctx.version };
    },
  },
  /**
   * Which model answers in this folder, what can be chosen on this computer, and whether a cloud key
   * is saved. The cloud's description comes from the one place it is written (src/cloud/openrouter.ts).
   */
  modelSettings: {
    run: async (ctx: Ctx) => {
      let local: LocalModel[] = [];
      try { local = await localModels(); } catch { /* the runtime is down; the list says so */ }
      return {
        choice: modelChoice(ctx.record(), bestLocal(local)),
        local,
        cloud: { label: CLOUD.label, sends: CLOUD.sends, suggested: CLOUD.suggested, keySaved: Boolean(ctx.cloudKey?.()), available: Boolean(ctx.cloudKey) },
      };
    },
  },
  /** Set the folder's answering model. A local model must be pinned, installed and fit; a hosted one needs a saved key. */
  setModel: {
    run: async (ctx: Ctx, choice: unknown) => {
      const c = (choice ?? {}) as ModelChoice;
      if (c.where === "local") {
        const m = (await localModels()).find((x) => x.name === c.model);
        if (!m) throw new Error(`${c.model} is not one of the models pinned for this app`);
        if (m.why) throw new Error(`${c.model} cannot answer here: ${m.why}`);
      } else if (c.where === "cloud" && !ctx.cloudKey?.()) {
        throw new Error(ctx.cloudKey ? `Save a ${CLOUD.label} key first.` : "The development server has no key; choose the cloud in the desktop application.");
      }
      return setModelChoice(ctx.record(), c);
    },
  },
  /** The hosted models that take a structured answer, fetched when the picker opens. Sends no key. */
  cloudModels: { run: async () => ({ models: await listCloudModels() }) },
  /** Only when the button is pressed: see src/download/update.ts for what the request carries. */
  checkForUpdates: { run: (ctx: Ctx) => checkForUpdate(ctx.version) },
  appearance: {
    shellOnly: "A browser follows its own appearance; the app's setting lives in the desktop application's profile.",
  },
  updateSettings: {
    shellOnly: "Update settings live in the desktop application's own profile, which a browser does not have.",
  },
  openSettings: {
    shellOnly: "A browser has no second window; Settings opens in this page instead.",
  },
  recentFolders: {
    shellOnly: "A browser serves one folder, named when the development server started.",
  },
  switchFolder: {
    shellOnly: "A browser serves one folder, named when the development server started.",
  },
  forgetFolder: {
    shellOnly: "A browser has no list of recent folders.",
  },
  saveCloudKey: {
    shellOnly: "A browser has no keychain to keep a key in; add the key in the desktop application.",
  },
  forgetCloudKey: {
    shellOnly: "A browser has no keychain to keep a key in; add the key in the desktop application.",
  },
  openDocument: {
    shellOnly: "A browser cannot open a file on this computer.",
  },
  showInFinder: {
    shellOnly: "A browser cannot show a file in Finder.",
  },
  openFolder: {
    shellOnly: "A browser cannot open a folder in Finder.",
  },
  chooseRecord: {
    shellOnly:
      "A browser cannot open a native folder picker. Open the folder once in the desktop application, " +
      "then start this server with --dir <folder>.",
  },
} satisfies Record<string, Handler>;

export type Name = keyof typeof API;
export type ShellOnlyName = { [K in Name]: (typeof API)[K] extends { shellOnly: string } ? K : never }[Name];
export const NAMES = Object.keys(API) as Name[];

/** A handler from the table, or null for a shell-only name, typed for calling with JSON arguments. */
export function runnerFor(name: Name): Run | null {
  const entry: Handler = API[name];
  return "run" in entry ? entry.run : null;
}
