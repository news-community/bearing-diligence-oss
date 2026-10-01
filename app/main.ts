/**
 * The desktop shell. It binds nothing.
 *
 * The renderer talks to the record over Electron IPC, so there is no port, no origin and nothing
 * for another process on the machine to connect to. The development server
 * under tools/ exists to drive the same page in a browser and is not part of this.
 *
 * Every handler comes from one table (src/ui/api.ts). This file supplies only what needs Electron:
 * the native dialogs for opening a folder, the queue that reads its documents one at a time, and three refusals that live here rather than in the page, because a renderer can be
 * persuaded and a main process cannot: no navigation away from the record, no new windows, and no
 * remote content.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, safeStorage, shell } from "electron";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocationRefused, openRecord, type Record as OpenRecord } from "../src/record/db.js";
import { NAMES, NoRecord, runnerFor, type Ctx, type ShellOnlyName } from "../src/ui/api.js";
import { chooseRecord, forgetFolder, recentFolders, rememberedRecord, rememberRecord } from "../src/ui/choose.js";
import { dataDirFor, fileIn, listFolder, readFolder } from "../src/ui/folder.js";
import {
  bundleOf,
  checkForUpdate,
  clearLeftovers,
  installable,
  installUpdate,
  isAppearance,
  launchCheck,
  readSettings,
  writeSettings,
  type Run,
  type UpdateCheck,
} from "../src/ui/updates.js";
import { createIntakeQueue } from "../src/ingest/queue.js";
import { GENERAL_MODEL } from "../src/harness/model.js";
import { stopRuntime } from "../src/harness/runtime.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * `--version-probe` prints the version and exits before anything opens: how the release workflow
 * and the installer ask a new copy what it is without launching it for a person.
 */
const PROBE = process.argv.includes("--version-probe");
if (PROBE) {
  process.stdout.write(app.getVersion() + "\n");
  app.exit(0);
}

/** The bundle this copy runs from, when it is a packaged app; null when run from source. */
const BUNDLE = app.isPackaged ? bundleOf(process.execPath) : null;

/** A command's exit code and output, whether it succeeded or not. */
const run: Run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || (err && !stderr ? err.message : "") });
    });
  });

const canWrite = (dir: string) => {
  try {
    rmSync(mkdtempSync(join(dir, ".bearing-diligence-probe-")), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
};

const canInstall = () => installable({ packaged: app.isPackaged, platform: process.platform, bundle: BUNDLE, canWrite });

// The shell's browser profile is Electron's own default, ~/Library/Application Support/Bearing
// Diligence, named from `productName` in package.json. A record's data lives in the folder the person opens.

const queue = createIntakeQueue({ model: GENERAL_MODEL });

/**
 * One open record per folder, kept while its documents are still being read. Switching folders
 * used to close the record under the job reading it, so the shell refused to switch while anything
 * read; readings take hours, so that refusal would have met people constantly. The queue carries
 * each job's record, so reading carries on in the folder left behind, and a record is closed once
 * nothing is queued for it and it is not the one shown.
 */
const records = new Map<string, OpenRecord>();
/** When each folder was opened before this session's opening of it: what "new since" means. */
const since = new Map<string, string | null>();

/** The folder shown. Read on every call, so the file is the only copy of the answer. */
const remembered = () => rememberedRecord(app.getPath("userData"));

/** Opening a folder, by any route: it goes to the front of the recent list, and "since" is kept. */
function opened(dir: string): void {
  since.set(dir, rememberRecord(app.getPath("userData"), dir));
}

function closeIdle(shown: string): void {
  const queued = queue.state().paths;
  for (const [dir, rec] of records) {
    if (dir === shown || queued.some((p) => p.startsWith(dir + "/"))) continue;
    rec.db.close();
    records.delete(dir);
  }
}

function record(): OpenRecord {
  const dir = remembered();
  if (!dir) throw new NoRecord();
  let rec = records.get(dir);
  if (!rec) {
    rec = openRecord(dataDirFor(dir));
    records.set(dir, rec);
  }
  closeIdle(dir);
  return rec;
}

/**
 * The cloud key, kept in the app's profile and encrypted by the operating system's keychain
 * (Electron's safeStorage), in a file only this user can read. Never in a folder, a record, a
 * setting file or a log, and never stored at all where the keychain is unavailable: a plain-text key
 * on disk is the thing this refuses.
 */
const KEY_FILE = () => join(app.getPath("userData"), "cloud-key.bin");
function cloudKey(): string | null {
  try {
    if (!existsSync(KEY_FILE()) || !safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(readFileSync(KEY_FILE())) || null;
  } catch {
    return null;
  }
}

const ctx = (): Ctx => {
  const dir = remembered();
  return { dir, since: dir ? (since.get(dir) ?? null) : null, version: app.getVersion(), record, intake: queue, cloudKey };
};

// The launch check's result, when it has been switched on; null otherwise, and then no request is made.
let atLaunch: Promise<UpdateCheck> | null = null;

const SHELL: Record<ShellOnlyName, (...args: any[]) => unknown> = {
  saveCloudKey: (key: unknown) => {
    const k = typeof key === "string" ? key.trim() : "";
    if (!k) throw new Error("That key is empty.");
    if (!safeStorage.isEncryptionAvailable()) throw new Error("This computer's keychain is not available, so the key is not stored.");
    writeFileSync(KEY_FILE(), safeStorage.encryptString(k), { mode: 0o600 });
    return { keySaved: true };
  },
  forgetCloudKey: () => {
    rmSync(KEY_FILE(), { force: true });
    return { keySaved: false };
  },
  chooseRecord: async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]!;
    const chosen = await chooseRecord(
      {
        pickFolder: async (defaultPath) => {
          const r = await dialog.showOpenDialog(win, {
            title: "Open a folder of documents",
            defaultPath,
            buttonLabel: "Open",
            properties: ["openDirectory", "createDirectory"],
          });
          return r.canceled ? null : (r.filePaths[0] ?? null);
        },
        approve: async (folder, v) => {
          const r = await dialog.showMessageBox(win, {
            type: "question",
            buttons: ["Open", "Cancel"],
            defaultId: 0,
            cancelId: 1,
            message: `Read the documents in ${folder}?`,
            detail:
              "Every PDF and text file in this folder and its subfolders is read, one at a time, on this " +
              "computer. The record keeps its own copy in a hidden .bearing-diligence folder inside it." +
              (v.observed.length ? `\n\nWorth knowing: ${v.observed.join("; ")}.` : ""),
          });
          return r.response === 0;
        },
      },
      "the person at this computer",
    );
    if (chosen.ok) {
      opened(chosen.dir);
      readFolder(chosen.dir, record(), queue);
      refreshAll();
    }
    return chosen;
  },
  /** The recent folders, most recent first, for the switcher in the header. */
  recentFolders: () => ({ current: remembered(), recent: recentFolders(app.getPath("userData")) }),
  /** Show a folder from the recent list. Only a folder on the list: the page supplies no new path. */
  switchFolder: (dir: unknown) => {
    if (!recentFolders(app.getPath("userData")).some((r) => r.dir === dir)) throw new Error("that folder is not in the recent list");
    opened(dir as string);
    try {
      readFolder(dir as string, record(), queue);
    } catch (e) {
      if (e instanceof LocationRefused) return { ok: false, verdict: e.verdict };
      throw e;
    }
    refreshAll();
    return { ok: true, dir };
  },
  /** Take a folder off the recent list. Its files and its record are not touched. */
  forgetFolder: (dir: unknown) => {
    forgetFolder(app.getPath("userData"), String(dir));
    refreshAll();
    return { ok: true };
  },
  openSettings: () => {
    openSettingsWindow();
    return { ok: true };
  },
  /** Open a document's own file, for the source pane's "Open the PDF". Only a file in the folder. */
  openDocument: async (documentId: unknown) => {
    const dir = remembered();
    if (!dir) throw new NoRecord();
    const file = listFolder(dir, record(), queue.state()).files.find((f) => f.document_id === Number(documentId));
    if (!file) throw new Error("That document is no longer in this folder, so there is no file to open.");
    const failed = await shell.openPath(file.path);
    if (failed) throw new Error(failed);
    return { ok: true };
  },
  /** Open this folder in Finder, from Settings. Only the folder already open, never a path from the page. */
  openFolder: async () => {
    const dir = remembered();
    if (!dir) throw new NoRecord();
    const failed = await shell.openPath(dir);
    if (failed) throw new Error(failed);
    return { ok: true };
  },
  showInFinder: (name: unknown) => {
    const dir = remembered();
    if (!dir) throw new NoRecord();
    shell.showItemInFolder(fileIn(listFolder(dir, record(), queue.state()), name).path);
    return { ok: true };
  },
  /**
   * Light, dark, or the Mac's own. Electron's theme source is what the page's colour scheme follows,
   * so both windows change at once and the page's tokens need no second copy.
   */
  appearance: (value?: unknown) => {
    const profile = app.getPath("userData");
    if (isAppearance(value)) writeSettings(profile, { appearance: value });
    const { appearance } = readSettings(profile);
    nativeTheme.themeSource = appearance;
    return { appearance };
  },
  updateSettings: async (checkAtLaunch?: unknown) => {
    const profile = app.getPath("userData");
    if (typeof checkAtLaunch === "boolean") writeSettings(profile, { checkAtLaunch });
    const s = readSettings(profile);
    return { checkAtLaunch: s.checkAtLaunch, atLaunch: atLaunch ? await atLaunch : null, install: canInstall() };
  },
  /** Only when Install is pressed, and only where it can work: see src/download/install.ts. */
  installUpdate: async () => {
    const can = canInstall();
    if (!can.ok) return { state: "refused", why: can.why };
    return installUpdate(app.getVersion(), BUNDLE!, { fetch, run });
  },
  /** After an update is in place: start the new copy. Only when Restart is pressed. */
  restartApp: () => {
    stopRuntime();
    app.relaunch();
    app.exit(0);
    return { ok: true };
  },
};

// Every name in the table is registered, and a shell-only name with no implementation here stops
// the shell rather than leaving the page a method that rejects for ever.
ipcMain.on("record:names", (e) => {
  e.returnValue = NAMES;
});
for (const name of NAMES) {
  const run = runnerFor(name);
  const handler = run ? (...args: unknown[]) => run(ctx(), ...args) : SHELL[name as ShellOnlyName];
  if (!handler) throw new Error(`the table marks ${name} shell-only and the shell does not supply it`);
  ipcMain.handle(`record:${name}`, (_e, ...args: unknown[]) => handler(...args));
}

/**
 * The menu bar. A command is sent to the page, which acts on what is selected there; the page owns
 * every action, so a menu item and the control beside a row run the same code. Settings shows
 * Cmd-comma without registering it (`registerAccelerator: false`), so the key reaches the page in
 * the shell and in the development server alike, and the page's handler is the only one.
 */
function buildMenu(): void {
  const send = (command: string) => () => BrowserWindow.getFocusedWindow()?.webContents.send("menu", command);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { label: "Settings…", accelerator: "CmdOrCtrl+,", registerAccelerator: false, click: () => openSettingsWindow() },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      {
        label: "Document",
        submenu: [
          { label: "Exclude Document", click: send("leave-out") },
          { label: "Include Again", click: send("include-again") },
          { type: "separator" },
          { label: "Show in Finder", click: send("show-in-finder") },
        ],
      },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

/**
 * A window onto the one page. Settings is the same page at `#settings` in a second window, so every
 * gate, the bridge and the smoke cover it without a second page to keep in step.
 */
function createWindow(view = ""): BrowserWindow {
  const win = new BrowserWindow({
    width: view === "settings" ? 720 : 1040,
    height: view === "settings" ? 760 : 820,
    title: view === "settings" ? "Settings" : "Bearing Diligence",
    // Hidden until the page has painted, so the window has no colour of its own. It used to paint
    // itself #fbfaf7, a second copy of the page's --paper that a dark theme would have needed a twin
    // of; showing the page's own first frame needs no copy at all, and a dark Mac gets no light flash.
    show: false,
    // The bear, for Windows and Linux; macOS takes the Dock icon below.
    icon: join(HERE, "icon", "bear-app-icon-1024.png"),
    webPreferences: {
      preload: join(HERE, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      // Off, because the spell checker is a route from the question field to the disk outside
      // anything this application owns: macOS keeps learned words under ~/Library/Spelling.
      spellcheck: false,
    },
  });
  // Nothing navigates anywhere. A packet is untrusted input and a renderer that can be talked into
  // loading a URL is a way out of the machine.
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.once("ready-to-show", () => win.show());
  void win.loadFile(join(HERE, "..", "src", "ui", "app.html"), view ? { hash: view } : undefined);
  return win;
}

let settingsWindow: BrowserWindow | null = null;
function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) return settingsWindow.focus();
  settingsWindow = createWindow("settings");
}

/** A folder changed in one window: every window shows the new one. */
function refreshAll(): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("menu", "refresh");
}

/**
 * Opened straight from its disk image, the app offers to move itself to Applications. Left there it
 * can never be updated, because nothing on a read-only disk image can be replaced.
 */
async function offerMoveToApplications(): Promise<void> {
  if (!BUNDLE || process.platform !== "darwin" || app.isInApplicationsFolder()) return;
  if (!BUNDLE.startsWith("/Volumes/") && !BUNDLE.includes("/AppTranslocation/")) return;
  const r = await dialog.showMessageBox({
    type: "question",
    buttons: ["Move to Applications", "Not Now"],
    defaultId: 0,
    cancelId: 1,
    message: "Move Bearing Diligence to your Applications folder?",
    detail: "It is running from its disk image, where it cannot be updated.",
  });
  if (r.response === 0) {
    try {
      app.moveToApplicationsFolder();
    } catch (e) {
      dialog.showErrorBox("Bearing Diligence was not moved", (e as Error).message);
    }
  }
}

if (!PROBE) app.whenReady().then(async () => {
  if (BUNDLE && !BUNDLE.startsWith("/Volumes/")) clearLeftovers(BUNDLE);
  await offerMoveToApplications();
  // In development the Dock shows Electron's own icon unless told otherwise; a signed build carries
  // the .icns instead (M6).
  if (process.platform === "darwin") app.dock?.setIcon(join(HERE, "icon", "bear-app-icon-1024.png"));
  buildMenu();
  nativeTheme.themeSource = readSettings(app.getPath("userData")).appearance;
  const shown = remembered();
  if (shown) opened(shown);
  createWindow();
  atLaunch = launchCheck(readSettings(app.getPath("userData")), () => checkForUpdate(app.getVersion()));
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on("window-all-closed", () => {
  stopRuntime();
  if (process.platform !== "darwin") app.quit();
});
app.on("web-contents-created", (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});
