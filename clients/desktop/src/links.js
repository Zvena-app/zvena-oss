// Pure rules of the desktop app (no Electron here, so `npm test` runs them
// with plain node): which server the app talks to, where a page may
// navigate in-app, how zvena:// links map to pages, which keys do what.

"use strict";

const DEFAULT_APP_URL = "https://zvena.app";

/**
 * A server origin the app may load, or null. https anywhere; plain http
 * only for this machine (a dev server or a test stand), never across a
 * network where the session cookie would travel in the clear.
 */
function serverOrigin(raw) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 500) return null;
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol === "https:") return u.origin;
  if (u.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname)) return u.origin;
  return null;
}

/** The app origin: APP_URL, else the saved setting, else zvena.app. */
function resolveAppOrigin(envUrl, savedUrl) {
  return serverOrigin(envUrl) || serverOrigin(savedUrl) || DEFAULT_APP_URL;
}

function parse(raw) {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Whether the URL is on the app's own origin (the only one that gets permissions). */
function isAppUrl(raw, appOrigin) {
  const u = parse(raw);
  return Boolean(u && u.origin === appOrigin);
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/i;

/**
 * Whether a page may open inside the app: the app origin, the Design
 * origin when one is set, and other https hosts under the app's own domain
 * (design.zvena.app next to zvena.app). Everything else goes to the browser.
 */
function isInAppUrl(raw, appOrigin, designOrigin) {
  const u = parse(raw);
  if (!u) return false;
  if (u.origin === appOrigin) return true;
  if (designOrigin && u.origin === designOrigin) return true;
  const app = parse(appOrigin);
  if (!app || app.protocol !== "https:" || u.protocol !== "https:" || u.port !== app.port) return false;
  if (LOCAL_HOST.test(app.hostname) || /^[\d.]+$/.test(app.hostname) || app.hostname.includes(":")) return false;
  return u.hostname.endsWith(`.${app.hostname}`);
}

/** What the system browser may be asked to open (never file:, javascript:, custom schemes). */
function isExternalOpenable(raw) {
  const u = parse(raw);
  return Boolean(u && (u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:"));
}

/**
 * Where a navigation of an app tab goes: "app" (stays in the tab), "browser"
 * (the system browser opens it, the tab stays put) or "block" (dropped:
 * file:, javascript:, data:, custom schemes).
 */
function navigationVerdict(raw, appOrigin, designOrigin) {
  if (isInAppUrl(raw, appOrigin, designOrigin)) return "app";
  return isExternalOpenable(raw) ? "browser" : "block";
}

/**
 * A zvena:// link as a page of the app, or null:
 *   zvena://open?url=<absolute URL>   — only when that URL is on the app origin;
 *   zvena://<path>                    — docs?ws=abc#Title-id → <app>/docs?ws=abc#Title-id.
 * Anything that would leave the app origin is ignored.
 */
function deepLinkTarget(raw, appOrigin) {
  if (typeof raw !== "string" || raw.length > 4000 || !/^zvena:/i.test(raw)) return null;
  const u = parse(raw);
  if (!u || u.protocol !== "zvena:" || u.username || u.password || u.port) return null;
  if (u.hostname === "open" && (u.pathname === "" || u.pathname === "/")) {
    const target = u.searchParams.get("url");
    return target && isAppUrl(target, appOrigin) ? new URL(target).toString() : null;
  }
  // zvena://docs?… parses with "docs" as the host; zvena:/docs or zvena:docs without one.
  const path = `${u.hostname}${u.pathname}`.replace(/^\/+/, "");
  if (/[\\]|^\/|(^|\/)\.\.(\/|$)/.test(path)) return null;
  const out = parse(`${appOrigin}/${path}${u.search}${u.hash}`);
  return out && out.origin === appOrigin ? out.toString() : null;
}

/** The zvena:// link in a launch's command line (Windows and Linux pass it as an argument). */
function deepLinkInArgv(argv) {
  return (Array.isArray(argv) ? argv : []).find((a) => typeof a === "string" && /^zvena:/i.test(a)) || null;
}

/** Two app URLs show the same page (the tab to focus instead of opening another). */
function samePage(a, b) {
  const x = parse(a);
  const y = parse(b);
  return Boolean(x && y && x.origin === y.origin && x.pathname.replace(/\/$/, "") === y.pathname.replace(/\/$/, "") && x.search === y.search && x.hash === y.hash);
}

/**
 * Whether the quick search window is still on search: Docs at #search, or
 * Docs with the hash cleared after it opened the dialog. Anything else (a
 * page's slug, another path) is a result to hand to the main window.
 */
function quickSearchStays(raw, appOrigin) {
  const u = parse(raw);
  if (!u || u.origin !== appOrigin) return false;
  return /^\/docs\/?$/.test(u.pathname) && (u.hash === "" || u.hash === "#" || u.hash === "#search");
}

// --- Keyboard shortcuts -------------------------------------------------------

const MODIFIERS = new Map([
  ["cmd", "CommandOrControl"],
  ["command", "Command"],
  ["cmdorctrl", "CommandOrControl"],
  ["commandorcontrol", "CommandOrControl"],
  ["ctrl", "Control"],
  ["control", "Control"],
  ["alt", "Alt"],
  ["option", "Alt"],
  ["altgr", "AltGr"],
  ["shift", "Shift"],
  ["super", "Super"],
  ["meta", "Super"],
]);
const NAMED_KEYS = new Map(
  ["Space", "Tab", "Backspace", "Delete", "Insert", "Return", "Up", "Down", "Left", "Right", "Home", "End", "PageUp", "PageDown", "Escape", "Plus"].map((k) => [k.toLowerCase(), k])
);
NAMED_KEYS.set("esc", "Escape");
NAMED_KEYS.set("enter", "Return");

/** A key of an accelerator in Electron's spelling, or null. */
function acceleratorKey(p) {
  if (/^[a-z0-9]$/i.test(p)) return p.toUpperCase();
  if (/^[`\-=[\];',./\\]$/.test(p)) return p;
  const f = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(p);
  if (f) return `F${f[1]}`;
  return NAMED_KEYS.get(p.toLowerCase()) ?? null;
}

/**
 * A global shortcut as Electron's accelerator ("Alt+Shift+Space"), or null
 * when it is not one: at least one modifier (a bare key would swallow that
 * key everywhere in the system), exactly one key, no repeats.
 */
function normalizeAccelerator(raw) {
  if (typeof raw !== "string" || raw.length > 60) return null;
  const parts = raw.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const mods = [];
  let key = null;
  for (const p of parts) {
    const m = MODIFIERS.get(p.toLowerCase());
    if (m) {
      if (mods.includes(m)) return null;
      mods.push(m);
      continue;
    }
    if (key) return null;
    key = acceleratorKey(p);
    if (!key) return null;
  }
  if (!key || mods.length === 0) return null;
  // Shift alone is not a modifier anyone means for a global shortcut.
  if (mods.length === 1 && mods[0] === "Shift") return null;
  return [...mods, key].join("+");
}

/**
 * The app action of a key press (Electron's before-input-event input), or
 * null. `mac`: ⌘ is the modifier; elsewhere Ctrl, with Alt+←/→ for history.
 */
function shortcutAction(input, mac) {
  if (!input || input.type !== "keyDown") return null;
  const mod = mac ? input.meta && !input.control : input.control && !input.meta;
  const key = String(input.key || "");
  const code = String(input.code || "");
  if (!mac && input.alt && !input.control && !input.meta && !input.shift) {
    if (key === "ArrowLeft") return { type: "back" };
    if (key === "ArrowRight") return { type: "forward" };
  }
  if (input.control && !input.meta && !input.alt && key === "Tab") return { type: input.shift ? "prevTab" : "nextTab" };
  if (!mod || input.alt) return null;
  if (input.shift) {
    if (code === "KeyT" || key.toLowerCase() === "t") return { type: "reopenTab" };
    if (code === "BracketLeft" || key === "{") return { type: "prevTab" };
    if (code === "BracketRight" || key === "}") return { type: "nextTab" };
    if (code === "KeyN" || key.toLowerCase() === "n") return { type: "newWindow" };
    return null;
  }
  if (code === "KeyT" || key.toLowerCase() === "t") return { type: "newTab" };
  if (code === "KeyW" || key.toLowerCase() === "w") return { type: "closeTab" };
  if (code === "KeyN" || key.toLowerCase() === "n") return { type: "newWindow" };
  if (code === "KeyR" || key.toLowerCase() === "r") return { type: "reload" };
  if (code === "BracketLeft" || key === "[") return { type: "back" };
  if (code === "BracketRight" || key === "]") return { type: "forward" };
  if (key === "PageUp") return { type: "prevTab" };
  if (key === "PageDown") return { type: "nextTab" };
  if (key === "=" || key === "+") return { type: "zoom", delta: 1 };
  if (key === "-") return { type: "zoom", delta: -1 };
  if (key === "0") return { type: "zoom", delta: 0 };
  const digit = /^Digit([1-9])$/.exec(code)?.[1] ?? (/^[1-9]$/.test(key) ? key : null);
  if (digit) return { type: "selectTab", index: Number(digit) };
  if (key === "," && mac) return { type: "settings" };
  return null;
}

/** The tab ⌘<n> selects: 1–8 by position, 9 the last (as in browsers). */
function tabIndexFor(n, count) {
  if (!count) return -1;
  if (n === 9) return count - 1;
  return n - 1 < count ? n - 1 : -1;
}

// --- Window state ----------------------------------------------------------------

/** Saved window bounds that are sane (on some screen is checked by the caller with real displays). */
function cleanBounds(b) {
  if (!b || typeof b !== "object") return null;
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
  const x = n(b.x);
  const y = n(b.y);
  const width = n(b.width);
  const height = n(b.height);
  if (width === null || height === null || width < 400 || height < 300 || width > 20000 || height > 20000) return null;
  return { ...(x !== null && y !== null ? { x, y } : {}), width, height };
}

/** Whether most of the bounds fall within one of the displays' work areas. */
function onSomeDisplay(bounds, areas) {
  if (!bounds || bounds.x === undefined) return false;
  return (areas || []).some((a) => {
    const w = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x);
    const h = Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y);
    return w >= Math.min(200, bounds.width / 2) && h >= Math.min(100, bounds.height / 2);
  });
}

/** Saved tabs of a window as URLs to reopen: app-origin pages only, at most 30. */
function restorableTabs(saved, appOrigin) {
  if (!saved || !Array.isArray(saved.tabs)) return { tabs: [], active: 0 };
  const tabs = saved.tabs.filter((u) => typeof u === "string" && isAppUrl(u, appOrigin)).slice(0, 30);
  const active = Number.isInteger(saved.active) && saved.active >= 0 && saved.active < tabs.length ? saved.active : 0;
  return { tabs, active };
}

module.exports = {
  DEFAULT_APP_URL,
  serverOrigin,
  resolveAppOrigin,
  isAppUrl,
  isInAppUrl,
  isExternalOpenable,
  navigationVerdict,
  deepLinkTarget,
  deepLinkInArgv,
  samePage,
  quickSearchStays,
  normalizeAccelerator,
  shortcutAction,
  tabIndexFor,
  cleanBounds,
  onSomeDisplay,
  restorableTabs,
};
