// Main process: the session's rules and the app's own pages.
//
// Pages of the zvena server run sandboxed with context isolation and no
// Node; the only bridge is preload/tab.js. Permissions: notifications,
// sanitized clipboard writes and full screen, for the app origin only;
// everything else (camera, location, devices, MIDI…) is refused, whoever
// asks. The app's own pages (the tab strip, Settings) are files served
// under zvena-ui:// with a strict policy of their own.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, protocol, session } = require("electron");

const UI_SCHEME = "zvena-ui";
const ALLOWED_PERMISSIONS = new Set(["notifications", "clipboard-sanitized-write", "fullscreen"]);

/** Before app ready: zvena-ui:// is a standard, secure origin (so 'self' and storage behave). */
function registerUiScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: UI_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false } }]);
}

const ROOT = path.join(__dirname, "..");
const UI_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";
const TYPES = { html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", woff2: "font/woff2", svg: "image/svg+xml", png: "image/png" };

/** zvena-ui://ui/<file>: src/ui/<file>, fonts/<file> and brand/<file> from assets/. Nothing else. */
function serveUi() {
  protocol.handle(UI_SCHEME, async (req) => {
    const u = new URL(req.url);
    const m = /^\/(?:(fonts|brand)\/)?([A-Za-z0-9_-]+\.(html|css|js|woff2|svg|png))$/.exec(u.pathname);
    if (u.host !== "ui" || !m) return new Response("not found", { status: 404 });
    const file = m[1] ? path.join(ROOT, "assets", m[1], m[2]) : path.join(ROOT, "src", "ui", m[2]);
    try {
      const body = await fs.promises.readFile(file);
      return new Response(body, { headers: { "content-type": TYPES[m[3]], "content-security-policy": UI_CSP, "x-content-type-options": "nosniff", "cache-control": "no-store" } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

function originOf(raw) {
  try {
    return new URL(raw).origin;
  } catch {
    return "";
  }
}

/**
 * Permission and download rules of the default session (every tab and the
 * quick search window share it, so one sign-in covers them all).
 * `appOrigin` is read on each request: the server can change in Settings.
 */
function hardenSession(appOrigin, locale) {
  const ses = session.defaultSession;
  const ok = (permission, url) => ALLOWED_PERMISSIONS.has(permission) && originOf(url) === appOrigin();
  ses.setPermissionRequestHandler((wc, permission, callback, details) => callback(ok(permission, details?.requestingUrl || wc?.getURL() || "")));
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => ok(permission, requestingOrigin || wc?.getURL() || ""));
  ses.setDevicePermissionHandler(() => false);
  ses.on("select-hid-device", (e, _d, cb) => (e.preventDefault(), cb()));
  ses.on("select-serial-port", (e, _p, _wc, cb) => (e.preventDefault(), cb("")));
  ses.on("select-usb-device", (e, _d, cb) => (e.preventDefault(), cb()));
  // The web app can tell the desktop from a browser (and the Electron token is dropped: some sign-in pages refuse it).
  const ua = ses.getUserAgent().replace(/\s(zvena|Electron)\/\S+/g, "");
  ses.setUserAgent(`${ua} zvena-desktop/${app.getVersion()}`);
  // Downloads: a save dialog that starts in the Downloads folder.
  ses.on("will-download", (_e, item) => {
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath("downloads"), item.getFilename()) });
  });
  // Spell check: the system's on macOS; elsewhere the interface language and US English.
  ses.setSpellCheckerEnabled(true);
  if (process.platform !== "darwin") {
    const have = ses.availableSpellCheckerLanguages || [];
    const want = [...new Set([have.find((l) => l.toLowerCase().startsWith(locale)), "en-US"].filter((l) => l && have.includes(l)))];
    if (want.length) ses.setSpellCheckerLanguages(want);
  }
  return ses;
}

/** webPreferences of every page this app shows. */
function securePrefs(extra = {}) {
  return {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    experimentalFeatures: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    ...extra,
  };
}

/** Every web contents the app ever makes: no <webview>, and no window opens by itself. */
function guardAllWebContents() {
  app.on("web-contents-created", (_e, wc) => {
    wc.on("will-attach-webview", (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
  });
}

module.exports = { UI_SCHEME, registerUiScheme, serveUi, hardenSession, securePrefs, guardAllWebContents, ALLOWED_PERMISSIONS };
