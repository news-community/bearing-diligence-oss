// The only bridge between the page and the record, built from the one table of handlers
// (src/ui/api.ts) rather than written out here. It used to list every method by hand, beside a
// second hand-written list in the development server, and a gate existed to keep the two equal.
// Now the main process says which names exist, and each one is an IPC call and nothing else: no
// way to reach the filesystem, the network or a shell from the renderer.
const { contextBridge, ipcRenderer } = require("electron");

const names = ipcRenderer.sendSync("record:names");
contextBridge.exposeInMainWorld(
  "record",
  Object.fromEntries(names.map((name) => [name, (...args) => ipcRenderer.invoke(`record:${name}`, ...args)])),
);

// The one thing the shell tells the page rather than being asked: a menu bar command. One channel,
// one listener, and only the command's name crosses it (the bridge gate allows exactly this).
contextBridge.exposeInMainWorld("menu", { on: (listener) => ipcRenderer.on("menu", (_e, command) => listener(String(command))) });
