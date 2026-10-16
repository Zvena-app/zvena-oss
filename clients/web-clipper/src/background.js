// The clipper's background: holds the token (the popup never sees it), runs
// the Connect flow, extracts pages and sends clips, and answers the context
// menu and the keyboard shortcuts. Chrome runs it as a service worker,
// Firefox as an event page: no state lives in globals between events.

/* global __ZV_SERVER__, __ZV_BROWSER__ */
import { call } from "./lib/api.js";
import { errorKey } from "./lib/errors.js";
import { buildPayload } from "./lib/payload.js";
import { challengeOf, makeState, makeVerifier, STATE_RE } from "./lib/pkce.js";
import { lastKey, pushRecent, recentsKey } from "./lib/recents.js";
import { originPattern, serverOrigin } from "./lib/urls.js";

const ext = globalThis.browser ?? globalThis.chrome;
/** The server a build for one server bakes in; "" in the default build (the person sets theirs). */
const DEFAULT_SERVER = __ZV_SERVER__;
const PENDING_TTL = 10 * 60_000;
const CUSTOM_SCRIPT = "zv-connect-custom";
const MENU_ID = "zv-save";

/** The last menu click's intent while this background is awake (session storage keeps it otherwise). */
let menuIntent = null;

// --- Storage -------------------------------------------------------------------

const local = ext.storage.local;
// Session storage (memory only) for the flow's verifier; local with an expiry where a browser lacks it.
const session = ext.storage.session ?? local;

async function serverOf() {
  const { server } = await local.get("server");
  return serverOrigin(server) || DEFAULT_SERVER;
}

async function authOf() {
  const [{ auth }, server] = await Promise.all([local.get("auth"), serverOf()]);
  if (!auth || auth.server !== server || typeof auth.token !== "string") return null;
  if (auth.expiresAt && auth.expiresAt < Date.now()) return null;
  return auth;
}

const clearAuth = () => local.remove("auth");

// --- Connect -------------------------------------------------------------------

function clientName() {
  if (__ZV_BROWSER__ === "firefox") return "firefox";
  return /\bEdg\//.test(navigator.userAgent) ? "edge" : "chrome";
}

async function startConnect() {
  const server = await serverOf();
  if (!server) return { ok: false, error: "serverInvalid" };
  const state = makeState();
  const verifier = makeVerifier();
  const challenge = await challengeOf(verifier);
  await session.set({ pending: { state, verifier, server, at: Date.now() } });
  const q = new URLSearchParams({ state, challenge, client: clientName() });
  await ext.tabs.create({ url: `${server}/clipper/connect?${q}` });
  return { ok: true };
}

async function finishConnect(msg, sender) {
  const { pending } = await session.get("pending");
  // Single use: whatever happens next, this flow is over.
  await session.remove("pending");
  if (!pending || Date.now() - pending.at > PENDING_TTL) return { ok: false, error: "errConnect" };
  let from = "";
  try {
    from = new URL(sender.url ?? "").origin;
  } catch {
    from = "";
  }
  // Only our own content script on the server's page, top frame, for the flow we started.
  if (sender.id !== ext.runtime.id || sender.frameId !== 0 || from !== pending.server) return { ok: false, error: "errConnect" };
  if (typeof msg.state !== "string" || !STATE_RE.test(msg.state) || msg.state !== pending.state) return { ok: false, error: "errConnect" };
  if (typeof msg.code !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(msg.code)) return { ok: false, error: "errConnect" };
  const r = await call(pending.server, null, "/api/clipper/token", { method: "POST", body: { code: msg.code, verifier: pending.verifier } });
  if (!r.ok || typeof r.body?.token !== "string") return { ok: false, error: r.status ? "errConnect" : "errNetwork" };
  const user = { id: String(r.body.user?.id ?? ""), name: String(r.body.user?.name ?? "") };
  await local.set({ auth: { server: pending.server, token: r.body.token, user, expiresAt: Number(r.body.expiresAt) || 0 } });
  if (sender.tab?.id !== undefined) ext.tabs.remove(sender.tab.id).catch(() => {});
  return { ok: true };
}

async function disconnect() {
  const auth = await authOf();
  if (auth) await call(auth.server, auth.token, "/api/clipper/token", { method: "DELETE", timeoutMs: 8000 });
  await clearAuth();
  return { ok: true };
}

/** The connect page's content script for the server the person set (a build for one server declares its own). */
async function ensureCustomScript(server) {
  const registered = await ext.scripting.getRegisteredContentScripts({ ids: [CUSTOM_SCRIPT] }).catch(() => []);
  const want = server && server !== DEFAULT_SERVER ? `${originPattern(server).slice(0, -1)}clipper/connected*` : "";
  const have = registered[0]?.matches?.[0] ?? "";
  if (have === want) return;
  if (registered.length) await ext.scripting.unregisterContentScripts({ ids: [CUSTOM_SCRIPT] }).catch(() => {});
  if (want) await ext.scripting.registerContentScripts([{ id: CUSTOM_SCRIPT, matches: [want], js: ["connect.js"], runAt: "document_start" }]);
}

async function setServer(raw) {
  const server = serverOrigin(raw);
  if (!server) return { ok: false, error: "serverInvalid" };
  if (server !== DEFAULT_SERVER && !(await ext.permissions.contains({ origins: [originPattern(server)] }))) return { ok: false, error: "errPermission" };
  const prev = await serverOf();
  if (prev !== server) await disconnect();
  if (server === DEFAULT_SERVER) await local.remove("server");
  else await local.set({ server });
  await ensureCustomScript(server);
  return { ok: true, server };
}

// --- The page ------------------------------------------------------------------

/** Title, address and selection of a tab; null where the browser forbids scripts (its own pages, stores). */
async function peek(tabId) {
  try {
    const [res] = await ext.scripting.executeScript({
      target: { tabId },
      func: () => ({ title: document.title, url: location.href, hasSelection: Boolean(getSelection()?.toString().trim()) }),
    });
    if (res?.result) return { ...res.result, scriptable: true };
  } catch {
    // Fall through to what the tab itself says.
  }
  try {
    const tab = await ext.tabs.get(tabId);
    if (tab?.url && /^https?:/.test(tab.url)) return { title: tab.title ?? "", url: tab.url, hasSelection: false, scriptable: false };
  } catch {
    // No access to the tab.
  }
  return null;
}

/** What the clip sends of the page (extract.js runs Readability on a copy of it). */
async function extract(tabId, article) {
  await ext.scripting.executeScript({ target: { tabId }, files: ["extract.js"] });
  const [res] = await ext.scripting.executeScript({ target: { tabId }, func: (a) => globalThis.__zvExtract?.({ article: a }) ?? null, args: [Boolean(article)] });
  return res?.result ?? null;
}

// --- Clips ---------------------------------------------------------------------

/**
 * Saves a clip. `page` comes ready from a context menu (a link, an image);
 * otherwise the tab is read now. → { ok, id, url, title } | { ok: false, error, retryAfter }
 */
async function clip({ tabId, ws, target, dest, mode, title, page }) {
  const auth = await authOf();
  if (!auth) return { ok: false, error: "errUnauthorized" };
  let p = page ?? null;
  if (!p) {
    try {
      p = await extract(tabId, mode === "article");
    } catch {
      p = null;
    }
    if (!p) {
      // A protected page still saves as a bookmark from what the tab tells.
      const seen = mode === "bookmark" ? await peek(tabId) : null;
      if (!seen) return { ok: false, error: "errNoPage" };
      p = { url: seen.url, title: seen.title };
    }
  }
  if (mode === "selection" && !p.selection) return { ok: false, error: "errNoSelection" };
  if (!/^https?:\/\//.test(p.url ?? "")) return { ok: false, error: "errNoPage" };
  const body = buildPayload({ ws, target, mode, title, page: p });
  const r = await call(auth.server, auth.token, "/api/notes/clip", { method: "POST", body, timeoutMs: 120_000 });
  if (!r.ok) {
    if (r.status === 401) await clearAuth();
    return { ok: false, error: errorKey(r.status, r.body), retryAfter: r.retryAfter };
  }
  const server = auth.server;
  const store = { [lastKey(server)]: { ws, target: body.target, dest: dest ?? null } };
  if (dest) {
    const key = recentsKey(server, ws);
    const have = (await local.get(key))[key];
    store[key] = pushRecent(have, dest);
  }
  await local.set(store);
  const url = typeof r.body?.url === "string" && r.body.url.startsWith(server) ? r.body.url : server;
  return { ok: true, id: r.body?.id, url, title: r.body?.title ?? body.title };
}

/** Where a clip goes without the popup: the last destination, else the person's Private in their last workspace. */
async function lastDestination() {
  const auth = await authOf();
  if (!auth) return null;
  const key = lastKey(auth.server);
  const last = (await local.get(key))[key];
  if (last?.ws) return last;
  const me = await call(auth.server, auth.token, "/api/clipper/me");
  if (!me.ok) return null;
  const ws = me.body?.lastWs || me.body?.workspaces?.find((w) => w.personal)?.id || me.body?.workspaces?.[0]?.id;
  return ws ? { ws, target: { type: "private" }, dest: null } : null;
}

async function badge(tabId, text, color, title) {
  try {
    await ext.action.setBadgeBackgroundColor({ color, tabId });
    await ext.action.setBadgeText({ text, tabId });
    await ext.action.setTitle({ title, tabId });
  } catch {
    // The tab closed meanwhile.
  }
}

const t = (key) => ext.i18n.getMessage(key) || key;

/** A clip with no popup (the shortcut, or a menu where the popup cannot open): the badge tells how it went. */
async function quickClip(tabId, mode, page) {
  await badge(tabId, "…", "#0d99ff", t("saving"));
  const to = await lastDestination();
  const res = to ? await clip({ tabId, ws: to.ws, target: to.target, dest: to.dest, mode, page }) : { ok: false, error: "errUnauthorized" };
  if (res.ok) await badge(tabId, "✓", "#14ae5c", t("saved"));
  else await badge(tabId, "!", "#f24822", t(res.error));
  setTimeout(() => {
    ext.action.setBadgeText({ text: "", tabId }).catch(() => {});
    ext.action.setTitle({ title: t("actionTitle"), tabId }).catch(() => {});
  }, 6000);
  // Not connected: the popup is where that is fixed.
  if (!res.ok && res.error === "errUnauthorized") ext.action.openPopup?.().catch(() => {});
  return res;
}

// --- Menu and shortcuts --------------------------------------------------------

function createMenu() {
  Promise.resolve(ext.contextMenus.removeAll())
    .then(() => ext.contextMenus.create({ id: MENU_ID, title: t("menuSave"), contexts: ["page", "selection", "link", "image"] }))
    .catch(() => {});
}

ext.runtime.onInstalled.addListener(createMenu);
ext.runtime.onStartup?.addListener(createMenu);

ext.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  let mode = "article";
  let page = null;
  if (info.linkUrl) {
    mode = "bookmark";
    page = { url: info.linkUrl, title: info.linkText || info.selectionText || info.linkUrl };
  } else if (info.srcUrl && info.mediaType === "image") {
    mode = "selection";
    page = { url: info.pageUrl || tab.url || "", title: tab.title || "", selection: `<p><img src="${escapeAttr(info.srcUrl)}"></p>` };
  } else if (info.selectionText) mode = "selection";
  // The popup lets the person pick where it goes; it reads this intent. The
  // popup is opened first, in the click itself (Firefox allows it only there).
  const intent = { tabId: tab.id, mode, page, at: Date.now() };
  menuIntent = intent;
  let opened;
  try {
    opened = Promise.resolve(ext.action.openPopup());
  } catch (e) {
    opened = Promise.reject(e);
  }
  session.set({ intent }).catch(() => {});
  opened.catch(() => {
    menuIntent = null;
    session.remove("intent").catch(() => {});
    void quickClip(tab.id, mode, page);
  });
});


ext.commands.onCommand.addListener((command, tab) => {
  if (command !== "save-page") return;
  void (async () => {
    const id = tab?.id ?? (await ext.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    if (id !== undefined) await quickClip(id, "article", null);
  })();
});

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// --- Messages ------------------------------------------------------------------

async function handle(msg, sender) {
  // The connect page's content script is the only sender that is not an extension page.
  if (msg?.type === "zv-connect") return finishConnect(msg, sender);
  if (sender.id !== ext.runtime.id || (sender.tab && !String(sender.url ?? "").startsWith(ext.runtime.getURL("")))) return { ok: false };
  switch (msg?.type) {
    case "state": {
      const [server, auth] = await Promise.all([serverOf(), authOf()]);
      return { server, defaultServer: DEFAULT_SERVER, user: auth?.user ?? null };
    }
    case "connect":
      return startConnect();
    case "disconnect":
      return disconnect();
    case "setServer":
      return setServer(msg.server);
    case "me": {
      const auth = await authOf();
      if (!auth) return { ok: false, error: "errUnauthorized" };
      const r = await call(auth.server, auth.token, "/api/clipper/me");
      if (r.status === 401) await clearAuth();
      return r.ok ? { ok: true, ...r.body } : { ok: false, error: errorKey(r.status, r.body) };
    }
    case "destinations": {
      const auth = await authOf();
      if (!auth) return { ok: false, error: "errUnauthorized" };
      const q = new URLSearchParams({ ws: String(msg.ws ?? ""), q: String(msg.q ?? "").slice(0, 200) });
      const r = await call(auth.server, auth.token, `/api/clipper/destinations?${q}`);
      if (r.status === 401) await clearAuth();
      const [recent, last] = await Promise.all([local.get(recentsKey(auth.server, msg.ws)), local.get(lastKey(auth.server))]);
      return r.ok
        ? { ok: true, results: Array.isArray(r.body?.results) ? r.body.results : [], recent: recent[recentsKey(auth.server, msg.ws)] ?? [], last: last[lastKey(auth.server)] ?? null }
        : { ok: false, error: errorKey(r.status, r.body) };
    }
    case "peek": {
      const intent = menuIntent ?? (await session.get("intent")).intent;
      const fresh = intent && intent.tabId === msg.tabId && Date.now() - intent.at < 30_000 ? intent : null;
      menuIntent = null;
      await session.remove("intent");
      return { ok: true, page: await peek(msg.tabId), intent: fresh };
    }
    case "clip":
      return clip(msg);
    default:
      return { ok: false };
  }
}

ext.runtime.onMessage.addListener((msg, sender, reply) => {
  handle(msg, sender).then(reply, () => reply({ ok: false, error: "errServer" }));
  return true;
});

// Firefox does not keep registered scripts across restarts: make sure the custom server's is there.
serverOf()
  .then(ensureCustomScript)
  .catch(() => {});
