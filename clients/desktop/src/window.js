// Main process: one app window — the tab strip on top (the app's own page,
// zvena-ui://ui/tabs.html) and a web view per tab below it. Tabs are zvena
// pages; a tab never leaves the app's origins (lib: links.js), anything
// else opens in the system browser.

"use strict";

const path = require("node:path");
const { app, BaseWindow, WebContentsView, nativeTheme, shell } = require("electron");
const { navigationVerdict, isAppUrl, isExternalOpenable, shortcutAction, tabIndexFor, samePage } = require("./links");
const { securePrefs } = require("./security");

const STRIP_H = 40;
const MAC = process.platform === "darwin";
const MAX_CLOSED = 25;

const colors = () =>
  nativeTheme.shouldUseDarkColors ? { chrome: "#1e1e1e", page: "#2c2c2c", symbols: "#ffffff" } : { chrome: "#f5f5f5", page: "#ffffff", symbols: "#1e1e1e" };

let tabSeq = 0;

class AppWindow {
  /**
   * `ctx`: what the window needs from the app — appOrigin(), designOrigin(),
   * settings, t, rtl, openExternal(url), contextMenu(win, wc, params),
   * runGlobal(action), onChange(), onClosing(win), onClosed(win).
   */
  constructor(ctx, { bounds, maximized, tabs = [], active = 0 } = {}) {
    this.ctx = ctx;
    this.tabs = [];
    this.activeId = null;
    this.closedTabs = [];
    this.fullScreen = false;
    const c = colors();
    this.win = new BaseWindow({
      width: bounds?.width ?? 1200,
      height: bounds?.height ?? 820,
      ...(bounds?.x !== undefined ? { x: bounds.x, y: bounds.y } : {}),
      minWidth: 520,
      minHeight: 400,
      title: "zvena",
      show: false,
      backgroundColor: c.chrome,
      ...(MAC ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 14, y: 13 } } : { titleBarStyle: "hidden", titleBarOverlay: { color: c.chrome, symbolColor: c.symbols, height: STRIP_H } }),
      ...(process.platform === "linux" ? { icon: path.join(__dirname, "..", "assets", "icon.png") } : {}),
    });
    this.chrome = new WebContentsView({ webPreferences: securePrefs({ preload: path.join(__dirname, "preload", "ui.js"), spellcheck: false, devTools: !app.isPackaged }) });
    this.chrome.setBackgroundColor(c.chrome);
    this.win.contentView.addChildView(this.chrome);
    this.guardOwnPage(this.chrome.webContents);
    this.chrome.webContents.on("before-input-event", (e, input) => this.onKey(e, input));
    void this.chrome.webContents.loadURL("zvena-ui://ui/tabs.html");

    this.win.on("resize", () => this.layout());
    this.win.on("enter-full-screen", () => ((this.fullScreen = true), this.pushState()));
    this.win.on("leave-full-screen", () => ((this.fullScreen = false), this.pushState()));
    for (const ev of ["resize", "move", "maximize", "unmaximize"]) this.win.on(ev, () => ctx.onChange());
    this.win.on("focus", () => this.activeTab()?.view.webContents.focus());
    this.win.on("close", () => ctx.onClosing(this));
    this.win.on("closed", () => {
      for (const tab of this.tabs) if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
      if (!this.chrome.webContents.isDestroyed()) this.chrome.webContents.close();
      this.tabs = [];
      ctx.onClosed(this);
    });
    this.onTheme = () => this.applyTheme();
    nativeTheme.on("updated", this.onTheme);
    this.win.once("closed", () => nativeTheme.off("updated", this.onTheme));

    const urls = tabs.length ? tabs : [`${ctx.appOrigin()}/home`];
    urls.forEach((u, i) => this.newTab(u, { activate: i === Math.min(active, urls.length - 1) }));
    if (maximized) this.win.maximize();
    this.layout();
    this.win.show();
  }

  // --- Tabs -------------------------------------------------------------------

  newTab(url, { activate = true, after } = {}) {
    const target = isAppUrl(url, this.ctx.appOrigin()) ? url : `${this.ctx.appOrigin()}/home`;
    const view = new WebContentsView({
      webPreferences: securePrefs({
        preload: path.join(__dirname, "preload", "tab.js"),
        spellcheck: true,
        devTools: true,
        additionalArguments: [`--zvena-version=${app.getVersion()}`, `--zvena-origin=${this.ctx.appOrigin()}`],
      }),
    });
    view.setBackgroundColor(colors().page);
    view.setVisible(false);
    const tab = { id: ++tabSeq, view, url: target, title: "", loading: true, failed: null };
    const at = after ? this.tabs.findIndex((t) => t.id === after) : -1;
    if (at >= 0) this.tabs.splice(at + 1, 0, tab);
    else this.tabs.push(tab);
    this.win.contentView.addChildView(view);
    this.wireTab(tab);
    void view.webContents.loadURL(target).catch(() => undefined);
    if (activate || !this.activeId) this.select(tab.id);
    else this.layout();
    this.pushState();
    return tab;
  }

  wireTab(tab) {
    const wc = tab.view.webContents;
    const changed = () => {
      this.pushState();
      this.ctx.onChange();
    };
    wc.on("page-title-updated", (_e, title) => {
      tab.title = title;
      if (tab.id === this.activeId) this.win.setTitle(title || "zvena");
      changed();
    });
    wc.on("did-start-loading", () => ((tab.loading = true), changed()));
    wc.on("did-stop-loading", () => ((tab.loading = false), changed()));
    const moved = (_e, url) => {
      if (isAppUrl(url, this.ctx.appOrigin())) tab.url = url;
      tab.failed = null;
      changed();
    };
    wc.on("did-navigate", moved);
    wc.on("did-navigate-in-page", (e, url, isMainFrame) => isMainFrame && moved(e, url));
    // Offline before the page could keep itself offline: the app's own page with a retry.
    wc.on("did-fail-load", (_e, code, _desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3 || !isAppUrl(url, this.ctx.appOrigin())) return;
      tab.failed = url;
      const q = new URLSearchParams({ m: this.ctx.t("cantReach"), r: this.ctx.t("retry"), dir: this.ctx.rtl ? "rtl" : "ltr" });
      void wc.loadURL(`zvena-ui://ui/offline.html?${q}`).catch(() => undefined);
    });
    wc.on("render-process-gone", (_e, d) => {
      if (d.reason !== "clean-exit" && !wc.isDestroyed()) void wc.loadURL(tab.url).catch(() => undefined);
    });
    // Where the tab may go (links.js); the rest opens in the browser or nowhere.
    const steer = (e, url) => {
      const v = navigationVerdict(url, this.ctx.appOrigin(), this.ctx.designOrigin());
      if (v === "app") return;
      e.preventDefault();
      if (v === "browser") this.ctx.openExternal(url);
    };
    wc.on("will-navigate", steer);
    wc.on("will-redirect", steer);
    wc.setWindowOpenHandler(({ url }) => {
      if (isAppUrl(url, this.ctx.appOrigin()) && this.ctx.settings.get("openLinksInApp")) this.newTab(url, { after: tab.id });
      else if (navigationVerdict(url, this.ctx.appOrigin(), this.ctx.designOrigin()) === "app" && !isAppUrl(url, this.ctx.appOrigin())) this.newTab(url, { after: tab.id });
      else if (isExternalOpenable(url)) this.ctx.openExternal(url);
      return { action: "deny" };
    });
    wc.on("before-input-event", (e, input) => this.onKey(e, input));
    wc.on("context-menu", (_e, params) => this.ctx.contextMenu(this, wc, params));
    wc.on("zoom-changed", (_e, dir) => this.zoom(dir === "in" ? 1 : -1, tab));
  }

  activeTab() {
    return this.tabs.find((t) => t.id === this.activeId) || null;
  }

  tabOf(wc) {
    return this.tabs.find((t) => !t.view.webContents.isDestroyed() && t.view.webContents.id === wc.id) || null;
  }

  select(id) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    this.activeId = id;
    for (const t of this.tabs) t.view.setVisible(t.id === id);
    this.layout();
    this.win.setTitle(tab.title || "zvena");
    if (this.win.isFocused()) tab.view.webContents.focus();
    this.pushState();
    this.ctx.onChange();
  }

  selectByOffset(step) {
    const i = this.tabs.findIndex((t) => t.id === this.activeId);
    if (i < 0 || this.tabs.length < 2) return;
    this.select(this.tabs[(i + step + this.tabs.length) % this.tabs.length].id);
  }

  close(id) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const tab = this.tabs[i];
    const wc = tab.view.webContents;
    // ⌘⇧T brings it back with its back/forward history where the runtime can.
    const history = wc.navigationHistory;
    const entries = history?.getAllEntries ? history.getAllEntries().filter((x) => isAppUrl(x.url, this.ctx.appOrigin())) : [];
    this.closedTabs.push({ url: tab.url, entries, index: Math.max(0, Math.min(entries.length - 1, history?.getActiveIndex ? history.getActiveIndex() : entries.length - 1)) });
    if (this.closedTabs.length > MAX_CLOSED) this.closedTabs.shift();
    this.tabs.splice(i, 1);
    this.win.contentView.removeChildView(tab.view);
    if (!wc.isDestroyed()) wc.close();
    if (this.tabs.length === 0) {
      this.win.close();
      return;
    }
    if (this.activeId === id) this.select(this.tabs[Math.min(i, this.tabs.length - 1)].id);
    else this.pushState();
    this.ctx.onChange();
  }

  reopenClosed() {
    const last = this.closedTabs.pop();
    if (!last) return;
    const tab = this.newTab(last.url);
    const history = tab.view.webContents.navigationHistory;
    if (last.entries.length > 1 && history?.restore) {
      history.restore({ entries: last.entries, index: last.index }).catch(() => undefined);
    }
  }

  move(id, to) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0 || !Number.isInteger(to) || to < 0 || to >= this.tabs.length || to === i) return;
    const [tab] = this.tabs.splice(i, 1);
    this.tabs.splice(to, 0, tab);
    this.pushState();
    this.ctx.onChange();
  }

  /** Focuses an open tab showing this page; false when there is none. */
  focusPage(url) {
    const tab = this.tabs.find((t) => samePage(t.url, url));
    if (!tab) return false;
    this.select(tab.id);
    this.focus();
    return true;
  }

  focus() {
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
    this.activeTab()?.view.webContents.focus();
  }

  // --- Commands ---------------------------------------------------------------

  run(action) {
    const tab = this.activeTab();
    const wc = tab?.view.webContents;
    const history = wc?.navigationHistory;
    switch (action.type) {
      case "newTab":
        return void this.newTab(`${this.ctx.appOrigin()}/home`);
      case "closeTab":
        return void (tab && this.close(tab.id));
      case "reopenTab":
        return void this.reopenClosed();
      case "selectTab": {
        const i = tabIndexFor(action.index, this.tabs.length);
        return void (i >= 0 && this.select(this.tabs[i].id));
      }
      case "nextTab":
        return void this.selectByOffset(1);
      case "prevTab":
        return void this.selectByOffset(-1);
      case "back":
        return void (history?.canGoBack() && history.goBack());
      case "forward":
        return void (history?.canGoForward() && history.goForward());
      case "reload":
        if (tab?.failed) return void wc.loadURL(tab.failed).catch(() => undefined);
        return void wc?.reload();
      case "zoom":
        return void this.zoom(action.delta, tab);
      default:
        return void this.ctx.runGlobal(action, this);
    }
  }

  zoom(delta, tab = this.activeTab()) {
    const wc = tab?.view.webContents;
    if (!wc) return;
    wc.setZoomLevel(delta === 0 ? 0 : Math.max(-3, Math.min(4, wc.getZoomLevel() + delta * 0.5)));
  }

  onKey(e, input) {
    const action = shortcutAction(input, MAC);
    if (!action) return;
    e.preventDefault();
    this.run(action);
  }

  /** A message of this window's tab strip (preload/ui.js), checked here. */
  onUi(msg) {
    const id = Number.isInteger(msg.id) ? msg.id : null;
    switch (msg.type) {
      case "ready":
        return this.pushState();
      case "select":
        return id !== null && this.select(id);
      case "close":
        return id !== null && this.close(id);
      case "move":
        return id !== null && this.move(id, msg.to);
      case "newTab":
      case "back":
      case "forward":
      case "reload":
        return this.run({ type: msg.type });
      case "retry": {
        const tab = this.activeTab();
        return tab?.failed && void tab.view.webContents.loadURL(tab.failed).catch(() => undefined);
      }
      case "menu":
        return this.ctx.runGlobal({ type: "menu" }, this);
      default:
        return undefined;
    }
  }

  // --- Layout and state ----------------------------------------------------------

  layout() {
    if (this.win.isDestroyed()) return;
    const { width, height } = this.win.getContentBounds();
    this.chrome.setBounds({ x: 0, y: 0, width, height: STRIP_H });
    const tab = this.activeTab();
    if (tab) tab.view.setBounds({ x: 0, y: STRIP_H, width, height: Math.max(0, height - STRIP_H) });
  }

  applyTheme() {
    if (this.win.isDestroyed()) return;
    const c = colors();
    this.win.setBackgroundColor(c.chrome);
    this.chrome.setBackgroundColor(c.chrome);
    for (const t of this.tabs) t.view.setBackgroundColor(c.page);
    if (!MAC) this.win.setTitleBarOverlay({ color: c.chrome, symbolColor: c.symbols, height: STRIP_H });
  }

  pushState() {
    const wc = this.chrome.webContents;
    // Before the strip page has asked (its "ready"), a message would be lost; it asks once it listens.
    if (wc.isDestroyed()) return;
    const t = this.ctx.t;
    const tab = this.activeTab();
    const history = tab?.view.webContents.navigationHistory;
    const key = MAC ? "⌘" : "Ctrl+";
    wc.send("zv:state", {
      platform: process.platform,
      fullScreen: this.fullScreen,
      rtl: this.ctx.rtl,
      canBack: Boolean(history?.canGoBack()),
      canForward: Boolean(history?.canGoForward()),
      tabs: this.tabs.map((x) => ({ id: x.id, title: x.title || (x.loading ? t("loading") : t("untitled")), loading: x.loading, active: x.id === this.activeId })),
      words: {
        newTab: `${t("newTab")} (${key}T)`,
        closeTab: `${t("closeTab")} (${key}W)`,
        back: `${t("back")} (${key}[)`,
        forward: `${t("forward")} (${key}])`,
        menu: t("menu"),
        cantReach: t("cantReach"),
        retry: t("retry"),
      },
    });
  }

  /** What to reopen next launch: bounds, maximized, the tabs' pages. */
  snapshot() {
    const active = this.tabs.findIndex((t) => t.id === this.activeId);
    return {
      bounds: this.win.isDestroyed() ? null : this.win.getNormalBounds(),
      maximized: !this.win.isDestroyed() && this.win.isMaximized(),
      tabs: this.tabs.map((t) => t.url).filter((u) => isAppUrl(u, this.ctx.appOrigin())),
      active: Math.max(0, active),
    };
  }

  /** The app's own pages never navigate and never open windows. */
  guardOwnPage(wc) {
    wc.on("will-navigate", (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
  }
}

/** The system browser, for http(s) and mailto only. */
function openInBrowser(url) {
  if (isExternalOpenable(url)) void shell.openExternal(url).catch(() => undefined);
}

module.exports = { AppWindow, STRIP_H, openInBrowser, colors };
