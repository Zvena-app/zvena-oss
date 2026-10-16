// Preload of zvena's pages (sandboxed, isolated world). The page gets one
// frozen object, window.zvenaDesktop — that it runs in the desktop app,
// the version and platform, and the dock badge. Nothing else crosses: no
// Node, no IPC handle, no file access. Pages of other origins (a sign-in
// provider) get nothing at all.

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const arg = (name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : "";
};

// The app's offline page (zvena-ui://ui/offline.html, loaded by the main process into the tab): its Retry button.
if (location.protocol === "zvena-ui:") contextBridge.exposeInMainWorld("zvUi", Object.freeze({ send: (type) => type === "retry" && ipcRenderer.send("zv:retry") }));

if (location.origin === arg("zvena-origin")) {
  contextBridge.exposeInMainWorld(
    "zvenaDesktop",
    Object.freeze({
      isDesktop: true,
      version: arg("zvena-version"),
      platform: process.platform,
      /** The unread count on the dock / taskbar icon (0 clears it). */
      setBadge: (n) => ipcRenderer.send("zv:badge", Math.max(0, Math.min(9999, Math.floor(Number(n) || 0)))),
    })
  );

  // A click on one of the page's notifications (Inbox) brings its window
  // and tab to the front: the page's Notification gains that click, and the
  // event crosses to here as a plain DOM event (the worlds share the DOM).
  window.addEventListener("zvena-desktop-focus", () => ipcRenderer.send("zv:focus"));
  try {
    contextBridge.executeInMainWorld({
      func: () => {
        const Base = window.Notification;
        if (typeof Base !== "function") return;
        class DesktopNotification extends Base {
          constructor(title, options) {
            super(title, options);
            this.addEventListener("click", () => window.dispatchEvent(new Event("zvena-desktop-focus")));
          }
        }
        Object.defineProperty(window, "Notification", { value: DesktopNotification, configurable: true, writable: true });
      },
    });
  } catch {
    // An older runtime: notifications still show, a click just doesn't raise the window.
  }
}
