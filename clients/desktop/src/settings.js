// The desktop app's settings and window state: one small JSON file in the
// user data folder. Written whole through a temp file and a rename, so a
// crash mid-write never leaves half a file; anything unreadable or out of
// range falls back to the default.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { normalizeAccelerator, serverOrigin } = require("./links");

const DEFAULTS = Object.freeze({
  /** "" = APP_URL; with neither, the app asks for the server on start. */
  serverUrl: "",
  designUrl: "",
  quickSearchShortcut: "Alt+Shift+Space",
  launchAtLogin: false,
  /** zvena links a page opens in a new window (target=_blank) become tabs here. */
  openLinksInApp: true,
  /** Windows open at the last quit, each with its bounds and tab URLs. */
  windows: [],
});

function clean(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const out = { ...DEFAULTS };
  if (typeof r.serverUrl === "string" && (r.serverUrl === "" || serverOrigin(r.serverUrl))) out.serverUrl = r.serverUrl === "" ? "" : serverOrigin(r.serverUrl);
  if (typeof r.designUrl === "string" && (r.designUrl === "" || serverOrigin(r.designUrl))) out.designUrl = r.designUrl === "" ? "" : serverOrigin(r.designUrl);
  if (typeof r.quickSearchShortcut === "string") out.quickSearchShortcut = r.quickSearchShortcut === "" ? "" : normalizeAccelerator(r.quickSearchShortcut) || DEFAULTS.quickSearchShortcut;
  if (typeof r.launchAtLogin === "boolean") out.launchAtLogin = r.launchAtLogin;
  if (typeof r.openLinksInApp === "boolean") out.openLinksInApp = r.openLinksInApp;
  if (Array.isArray(r.windows)) {
    out.windows = r.windows
      .filter((w) => w && typeof w === "object" && Array.isArray(w.tabs))
      .slice(0, 8)
      .map((w) => ({
        bounds: w.bounds && typeof w.bounds === "object" ? w.bounds : null,
        maximized: w.maximized === true,
        tabs: w.tabs.filter((t) => typeof t === "string" && t.length < 4000).slice(0, 30),
        active: Number.isInteger(w.active) ? w.active : 0,
      }));
  }
  return out;
}

class Settings {
  constructor(dir) {
    this.file = path.join(dir, "zvena-settings.json");
    this.data = { ...DEFAULTS };
    try {
      this.data = clean(JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch {
      // First run or a broken file: defaults.
    }
  }

  get(key) {
    return this.data[key];
  }

  /** Changes some settings (cleaned like a file read) and saves. */
  set(patch) {
    this.data = clean({ ...this.data, ...patch });
    this.save();
    return this.data;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {
      // A read-only profile: the settings live for this run only.
    }
  }
}

module.exports = { Settings, DEFAULTS, clean };
