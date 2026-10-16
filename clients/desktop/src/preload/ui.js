// Preload of the app's own pages (the tab strip, Settings, the offline
// page): a few named messages to the main process, which checks that each
// one comes from its own page before acting.

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const COMMANDS = new Set(["select", "close", "newTab", "back", "forward", "reload", "menu", "retry", "move"]);

contextBridge.exposeInMainWorld(
  "zvUi",
  Object.freeze({
    /** A tab strip command: { type, id?, to? }. */
    send: (type, payload) => {
      if (COMMANDS.has(type)) ipcRenderer.send("zv:ui", { type, ...(payload && typeof payload === "object" ? payload : {}) });
    },
    /** The window's tabs and words, each time they change. */
    onState: (fn) => {
      ipcRenderer.on("zv:state", (_e, state) => fn(state));
      ipcRenderer.send("zv:ui", { type: "ready" });
    },
    settings: {
      load: () => ipcRenderer.invoke("zv:settings-get"),
      save: (values) => ipcRenderer.invoke("zv:settings-save", values),
      close: () => ipcRenderer.send("zv:settings-close"),
    },
  })
);
