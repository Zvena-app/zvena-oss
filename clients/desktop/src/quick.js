// Main process: the quick search window (a global shortcut, ⌥⇧Space by
// default). A small frameless window with Docs' search (/docs#search).
// Picking a result navigates it away from search: that page opens in a tab
// of the main window and this window hides, ready for the next time.

"use strict";

const path = require("node:path");
const { app, BrowserWindow, screen } = require("electron");
const { isAppUrl, navigationVerdict, isExternalOpenable, quickSearchStays } = require("./links");
const { securePrefs } = require("./security");
const { colors } = require("./window");

class QuickSearch {
  /** `ctx`: appOrigin(), designOrigin(), openInMain(url), openExternal(url). */
  constructor(ctx) {
    this.ctx = ctx;
    this.win = null;
    this.ready = false;
  }

  url() {
    return `${this.ctx.appOrigin()}/docs#search`;
  }

  create() {
    const win = new BrowserWindow({
      width: 680,
      height: 460,
      show: false,
      frame: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      backgroundColor: colors().page,
      roundedCorners: true,
      webPreferences: securePrefs({
        preload: path.join(__dirname, "preload", "tab.js"),
        spellcheck: true,
        additionalArguments: [`--zvena-version=${app.getVersion()}`, `--zvena-origin=${this.ctx.appOrigin()}`],
      }),
    });
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    const wc = win.webContents;
    wc.on("did-finish-load", () => (this.ready = true));
    wc.on("did-start-loading", () => (this.ready = false));
    const result = (url) => {
      if (!this.ready || quickSearchStays(url, this.ctx.appOrigin()) || !isAppUrl(url, this.ctx.appOrigin())) return;
      this.hide();
      this.ctx.openInMain(url);
    };
    wc.on("did-navigate", (_e, url) => result(url));
    wc.on("did-navigate-in-page", (_e, url, isMainFrame) => isMainFrame && result(url));
    wc.on("will-navigate", (e, url) => {
      if (navigationVerdict(url, this.ctx.appOrigin(), this.ctx.designOrigin()) === "app") return;
      e.preventDefault();
      if (isExternalOpenable(url)) this.ctx.openExternal(url);
    });
    wc.setWindowOpenHandler(({ url }) => {
      if (isAppUrl(url, this.ctx.appOrigin())) (this.hide(), this.ctx.openInMain(url));
      else if (isExternalOpenable(url)) this.ctx.openExternal(url);
      return { action: "deny" };
    });
    wc.on("before-input-event", (e, input) => {
      if (input.type === "keyDown" && input.key === "Escape") {
        e.preventDefault();
        this.hide();
      }
    });
    win.on("blur", () => this.hide());
    win.on("closed", () => (this.win = null));
    void wc.loadURL(this.url()).catch(() => undefined);
    this.win = win;
    return win;
  }

  toggle() {
    if (this.win?.isVisible()) return this.hide();
    const win = this.win && !this.win.isDestroyed() ? this.win : this.create();
    // Centered a little above the middle of the screen the pointer is on.
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const [w, h] = win.getSize();
    win.setPosition(Math.round(area.x + (area.width - w) / 2), Math.round(area.y + (area.height - h) / 3));
    win.show();
    win.focus();
    win.webContents.focus();
  }

  hide() {
    const win = this.win;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    win.hide();
    // Back to a fresh search box for the next time (the dialog closed or a result opened).
    void win.webContents.loadURL(this.url()).catch(() => undefined);
  }

  /** The server changed (Settings): the next toggle loads the new one. */
  reset() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { QuickSearch };
