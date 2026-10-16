// zvena for desktop — the main process.
//
// The app is a window onto the zvena web app (APP_URL, else the server
// set in Settings; with neither, the first start asks for the server's
// address in Settings before any window opens) with what a browser tab cannot
// do: tabs of its own, zvena:// links, a quick search shortcut that works
// in every app, the dock badge, launch at login, updates. All the product
// lives on the server; the pages work offline through the web app's own
// service worker and local store.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, globalShortcut, ipcMain, Menu, screen } = require("electron");
const { cleanBounds, deepLinkInArgv, deepLinkTarget, isAppUrl, normalizeAccelerator, onSomeDisplay, resolveAppOrigin, restorableTabs, serverOrigin } = require("./links");
const { localeOf, translator, isRtl } = require("./i18n");
const { Settings } = require("./settings");
const { guardAllWebContents, hardenSession, registerUiScheme, securePrefs, serveUi } = require("./security");
const { AppWindow, colors, openInBrowser } = require("./window");
const { appMenu, contextMenu, trayOrDock } = require("./menus");
const { QuickSearch } = require("./quick");

const MAC = process.platform === "darwin";
const PROTOCOL = "zvena";

// One running app: a second launch (a zvena:// link on Windows and Linux)
// hands its arguments to this one and quits.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// A packaged app opens no debugging port (another program on the machine
// could drive the signed-in session through it), unless asked for on purpose.
if (app.isPackaged && process.env.ZVENA_DEVTOOLS !== "1" && ["remote-debugging-port", "remote-debugging-pipe", "inspect", "inspect-brk"].some((s) => app.commandLine.hasSwitch(s))) {
  app.quit();
  process.exit(0);
}

registerUiScheme();
guardAllWebContents();
// Chromium's own sandbox for every renderer, whatever a window asks for.
app.enableSandbox();

let settings = null;
let t = (k) => k;
let locale = "en";
const windows = new Set();
let quick = null;
/** Kept referenced: a collected Tray disappears from the panel. */
let tray = null;
let quitting = false;
let pendingLink = deepLinkInArgv(process.argv);
let updates = null;
let saveTimer = null;
let lastClosed = null;

const appOrigin = () => resolveAppOrigin(process.env.APP_URL, settings?.get("serverUrl"));
const designOrigin = () => serverOrigin(process.env.DESIGN_URL) || serverOrigin(settings?.get("designUrl")) || null;

function openExternal(url) {
  openInBrowser(url);
}

// --- Windows ------------------------------------------------------------------------

function focusedWindow() {
  for (const w of windows) if (w.win.isFocused()) return w;
  return [...windows].pop() || null;
}

function windowOf(wc) {
  for (const w of windows) if (w.chrome.webContents === wc || w.tabOf(wc)) return w;
  return null;
}

function newWindow(state = {}) {
  // No server yet: Settings asks for it, and the window opens once it is saved.
  if (!appOrigin()) return void openSettings();
  let bounds = cleanBounds(state.bounds);
  if (bounds && !onSomeDisplay(bounds, screen.getAllDisplays().map((d) => d.workArea))) bounds = { width: bounds.width, height: bounds.height };
  // A new window steps down and right of the focused one, as browsers do.
  const from = focusedWindow();
  if (!bounds && from) {
    const b = from.win.getNormalBounds();
    bounds = { x: b.x + 28, y: b.y + 28, width: b.width, height: b.height };
  }
  const w = new AppWindow(windowCtx, { ...state, bounds });
  windows.add(w);
  return w;
}

const windowCtx = {
  appOrigin,
  designOrigin,
  get settings() {
    return settings;
  },
  get t() {
    return t;
  },
  get rtl() {
    return isRtl(locale);
  },
  openExternal,
  contextMenu: (win, wc, params) => contextMenu({ t, openExternal, devTools: devToolsOn() }, win, wc, params),
  runGlobal: (action, win) => runGlobal(action, win),
  onChange: () => scheduleSave(),
  onClosing: (win) => {
    // The last window closed (not quitting): it is what the next launch reopens.
    if (!quitting && windows.size === 1) lastClosed = win.snapshot();
  },
  onClosed: (win) => {
    windows.delete(win);
    scheduleSave();
  },
};

function devToolsOn() {
  return !app.isPackaged || process.env.ZVENA_DEVTOOLS === "1";
}

function runGlobal(action, win) {
  switch (action.type) {
    case "newWindow":
      return void newWindow();
    case "settings":
      return void openSettings();
    case "devTools": {
      const wc = (win || focusedWindow())?.activeTab()?.view.webContents;
      return void (wc && devToolsOn() && wc.toggleDevTools());
    }
    case "menu": {
      const menu = Menu.getApplicationMenu();
      return void (menu && win && menu.popup({ window: win.win, x: 8, y: 40 }));
    }
    default:
      return undefined;
  }
}

/** Runs a window command on the focused window (or opens one). */
function runOnFocused(action) {
  if (action.type === "newWindow") return newWindow();
  const w = focusedWindow();
  if (w) w.run(action);
  else if (action.type === "newTab") newWindow();
}

/** Opens an app page: a tab already showing it comes to the front, else a new tab. */
function openPage(url) {
  for (const w of windows) if (w.focusPage(url)) return;
  const w = focusedWindow();
  if (!w) return void newWindow({ tabs: [url] });
  w.newTab(url);
  w.focus();
}

function openDeepLink(raw) {
  if (!appOrigin()) {
    pendingLink = raw;
    return void openSettings();
  }
  const url = deepLinkTarget(raw, appOrigin());
  if (url) openPage(url);
  else focusedWindow()?.focus();
}

// --- State ----------------------------------------------------------------------------

function snapshotAll() {
  const open = [...windows].map((w) => w.snapshot()).filter((s) => s.tabs.length);
  return open.length ? open : lastClosed ? [lastClosed] : [];
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (settings && !quitting) settings.set({ windows: snapshotAll() });
  }, 1500);
}

function restoreWindows() {
  const saved = settings.get("windows").map((w) => ({ ...w, ...restorableTabs(w, appOrigin()) })).filter((w) => w.tabs.length);
  if (!saved.length) return void newWindow();
  for (const w of saved) newWindow(w);
}

// --- Quick search, settings, launch at login ---------------------------------------------

let shortcutOk = true;

/** The quick search window, or Settings while there is no server yet. */
function quickSearch() {
  if (appOrigin()) quick.toggle();
  else openSettings();
}

function registerShortcut(acc) {
  globalShortcut.unregisterAll();
  if (!acc) return true;
  try {
    return globalShortcut.register(acc, () => quickSearch());
  } catch {
    return false;
  }
}

/** Launch at login: the system's login items on macOS and Windows, an autostart entry on Linux. */
function setLaunchAtLogin(on) {
  if (process.platform === "linux") {
    const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "autostart");
    const file = path.join(dir, "zvena.desktop");
    try {
      if (!on) return void fs.rmSync(file, { force: true });
      const exec = process.env.APPIMAGE || process.execPath;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=zvena\nExec="${exec.replace(/"/g, "")}" --hidden\nX-GNOME-Autostart-enabled=true\n`);
    } catch {
      // No autostart folder to write: the setting stays off in effect.
    }
    return;
  }
  app.setLoginItemSettings({ openAtLogin: on, args: ["--hidden"] });
}

let settingsWin = null;

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) return void settingsWin.focus();
  settingsWin = new BrowserWindow({
    width: 520,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: t("settingsTitle"),
    show: false,
    autoHideMenuBar: true,
    backgroundColor: colors().page,
    webPreferences: securePrefs({ preload: path.join(__dirname, "preload", "ui.js"), spellcheck: false, devTools: !app.isPackaged }),
  });
  settingsWin.removeMenu?.();
  settingsWin.webContents.on("will-navigate", (e) => e.preventDefault());
  settingsWin.once("ready-to-show", () => settingsWin?.show());
  settingsWin.on("closed", () => {
    settingsWin = null;
    // Closed on the first start without a server: there is nothing to show.
    if (!appOrigin() && windows.size === 0 && !quitting) app.quit();
  });
  void settingsWin.loadURL("zvena-ui://ui/settings.html");
}

function settingsView() {
  const s = settings.data;
  return {
    values: { serverUrl: s.serverUrl || "", designUrl: s.designUrl || "", quickSearchShortcut: s.quickSearchShortcut, launchAtLogin: s.launchAtLogin, openLinksInApp: s.openLinksInApp },
    envServer: serverOrigin(process.env.APP_URL) || "",
    shortcutOk,
    /** No APP_URL and no saved server: the address must be filled in. */
    needsServer: !appOrigin(),
    exampleServer: "https://zvena.example.com",
    rtl: isRtl(locale),
    words: Object.fromEntries(["settingsTitle", "serverUrl", "serverHint", "designUrl", "shortcut", "shortcutHint", "launchAtLogin", "openLinksInApp", "save", "cancel", "invalidUrl", "invalidShortcut", "shortcutTaken"].map((k) => [k, t(k)])),
  };
}

function saveSettings(v) {
  const r = v && typeof v === "object" ? v : {};
  const errors = {};
  const server = typeof r.serverUrl === "string" ? r.serverUrl.trim() : "";
  const design = typeof r.designUrl === "string" ? r.designUrl.trim() : "";
  const withScheme = (s) => (s && !/^[a-z]+:\/\//i.test(s) ? `https://${s}` : s);
  const serverO = server ? serverOrigin(withScheme(server)) : "";
  const designO = design ? serverOrigin(withScheme(design)) : "";
  if (server && !serverO) errors.serverUrl = t("invalidUrl");
  // There is no built-in server: without APP_URL the address is required.
  if (!server && !serverOrigin(process.env.APP_URL)) errors.serverUrl = t("serverNeeded");
  if (design && !designO) errors.designUrl = t("invalidUrl");
  const rawAcc = typeof r.quickSearchShortcut === "string" ? r.quickSearchShortcut.trim() : "";
  const acc = rawAcc ? normalizeAccelerator(rawAcc) : "";
  if (rawAcc && !acc) errors.quickSearchShortcut = t("invalidShortcut");
  if (Object.keys(errors).length) return { ok: false, errors };
  const before = appOrigin();
  if (acc !== settings.get("quickSearchShortcut")) {
    if (!registerShortcut(acc)) {
      registerShortcut(settings.get("quickSearchShortcut"));
      return { ok: false, errors: { quickSearchShortcut: t("shortcutTaken") } };
    }
    shortcutOk = true;
  }
  const launch = r.launchAtLogin === true;
  if (launch !== settings.get("launchAtLogin")) setLaunchAtLogin(launch);
  settings.set({ serverUrl: serverO || "", designUrl: designO || "", quickSearchShortcut: acc, launchAtLogin: launch, openLinksInApp: r.openLinksInApp !== false });
  // Another server: its pages replace the old server's in every window.
  if (appOrigin() !== before) {
    quick.reset();
    for (const w of [...windows]) w.win.close();
    newWindow();
    if (pendingLink) {
      const link = pendingLink;
      pendingLink = null;
      openDeepLink(link);
    }
  }
  return { ok: true };
}

// --- IPC: every message is checked against who sent it ------------------------------------

function wireIpc() {
  ipcMain.on("zv:ui", (e, msg) => {
    const w = windowOf(e.sender);
    if (!w || w.chrome.webContents !== e.sender || !msg || typeof msg.type !== "string") return;
    w.onUi(msg);
  });
  ipcMain.on("zv:retry", (e) => {
    const w = windowOf(e.sender);
    const tab = w?.tabOf(e.sender);
    if (tab?.failed) void tab.view.webContents.loadURL(tab.failed).catch(() => undefined);
  });
  ipcMain.on("zv:badge", (e, n) => {
    if (!isAppUrl(e.senderFrame?.url || e.sender.getURL(), appOrigin()) || !Number.isInteger(n) || n < 0) return;
    app.setBadgeCount(Math.min(n, 9999));
  });
  let lastFocus = 0;
  ipcMain.on("zv:focus", (e) => {
    if (!isAppUrl(e.sender.getURL(), appOrigin()) || Date.now() - lastFocus < 1000) return;
    lastFocus = Date.now();
    const w = windowOf(e.sender);
    const tab = w?.tabOf(e.sender);
    if (!w || !tab) return;
    w.select(tab.id);
    w.focus();
    if (MAC) app.focus({ steal: true });
  });
  const fromSettings = (e) => settingsWin && !settingsWin.isDestroyed() && e.sender === settingsWin.webContents;
  ipcMain.handle("zv:settings-get", (e) => (fromSettings(e) ? settingsView() : null));
  ipcMain.handle("zv:settings-save", (e, v) => (fromSettings(e) ? saveSettings(v) : { ok: false, errors: {} }));
  ipcMain.on("zv:settings-close", (e) => fromSettings(e) && settingsWin.close());
}

// --- Updates ----------------------------------------------------------------------------

/**
 * electron-updater from a generic feed: ZVENA_UPDATE_URL at run time, or the
 * feed baked in at build time (app-update.yml). Without either, or in an
 * unpackaged run, updates are off and the menu does not offer them.
 */
function startUpdates() {
  if (!app.isPackaged) return null;
  const url = serverOrigin(process.env.ZVENA_UPDATE_URL || "") ? process.env.ZVENA_UPDATE_URL : "";
  const baked = fs.existsSync(path.join(process.resourcesPath, "app-update.yml"));
  if (!url && !baked) return null;
  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch {
    return null;
  }
  if (url) autoUpdater.setFeedURL({ provider: "generic", url });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("error", () => undefined);
  const check = () => void autoUpdater.checkForUpdates().catch(() => undefined);
  setTimeout(check, 30_000);
  setInterval(check, 6 * 3600_000).unref?.();
  return () => void autoUpdater.checkForUpdatesAndNotify().catch(() => undefined);
}

// --- Life cycle ---------------------------------------------------------------------------

// zvena:// opens this app (installers register it too; this covers a dev run and repairs).
if (process.defaultApp && process.argv.length >= 2) app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
else app.setAsDefaultProtocolClient(PROTOCOL);

app.on("open-url", (e, url) => {
  e.preventDefault();
  if (app.isReady() && settings) openDeepLink(url);
  else pendingLink = url;
});

app.on("second-instance", (_e, argv) => {
  const link = deepLinkInArgv(argv);
  if (link) return void openDeepLink(link);
  const w = focusedWindow();
  if (w) w.focus();
  else newWindow();
});

app.whenReady().then(() => {
  settings = new Settings(app.getPath("userData"));
  locale = localeOf(app.getLocale());
  t = translator(locale);
  serveUi();
  hardenSession(appOrigin, locale);
  quick = new QuickSearch({ appOrigin, designOrigin, openInMain: openPage, openExternal });
  updates = startUpdates();
  const menuCtx = { t, run: runOnFocused, newWindow: () => newWindow(), quickSearch, settings: openSettings, help: () => (appOrigin() ? openPage(`${appOrigin()}/help`) : openSettings()), updates, devTools: devToolsOn() };
  Menu.setApplicationMenu(appMenu(menuCtx));
  tray = trayOrDock({ ...menuCtx, show: () => (focusedWindow() ? focusedWindow().focus() : newWindow()) });
  wireIpc();
  shortcutOk = registerShortcut(settings.get("quickSearchShortcut"));
  if (settings.get("launchAtLogin")) setLaunchAtLogin(true);
  // Launched at login: the app waits in the tray / dock without a window.
  const hidden = process.argv.includes("--hidden") || (MAC && app.getLoginItemSettings().wasOpenedAsHidden);
  if (!hidden || pendingLink) restoreWindows();
  if (pendingLink) {
    const link = pendingLink;
    pendingLink = null;
    openDeepLink(link);
  }
  app.on("activate", () => {
    if (windows.size === 0) restoreWindows();
  });
});

app.on("before-quit", () => {
  if (settings) settings.set({ windows: snapshotAll() });
  quitting = true;
});

app.on("window-all-closed", () => {
  // macOS keeps the app in the dock; elsewhere the last window ends it.
  if (!MAC) app.quit();
});

app.on("will-quit", () => globalShortcut.unregisterAll());

// Certificate errors are never waved through, whatever the page.
app.on("certificate-error", (e, _wc, _url, _err, _cert, callback) => {
  e.preventDefault();
  callback(false);
});

