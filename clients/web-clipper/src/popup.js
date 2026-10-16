// The clipper's popup: the title, where the clip goes ("Add to"), how it
// is saved ("Save as") and Save. Everything that needs the token happens in
// the background; the popup only asks it.

import { pushRecent, safeIcon } from "./lib/recents.js";
import { originPattern, serverOrigin } from "./lib/urls.js";

const ext = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const t = (key) => ext.i18n.getMessage(key) || key;
const ask = (m) => ext.runtime.sendMessage(m);

// Test hook: popup.html?tab=<id> acts on that tab (a popup opened as a page would target itself).
const params = new URLSearchParams(location.search);
const testTab = params.has("tab") ? Number(params.get("tab")) : null;
if (testTab !== null) document.body.classList.add("zc-tab");

const state = {
  server: "",
  defaultServer: "",
  user: null,
  tabId: null,
  page: null,
  intent: null,
  workspaces: [],
  ws: "",
  target: { type: "private" },
  dest: null,
  results: [],
  recent: [],
  query: "",
  seq: 0,
};

// --- Words ---------------------------------------------------------------------

function localize() {
  document.documentElement.lang = ext.i18n.getUILanguage?.() || "en";
  document.documentElement.dir = t("@@bidi_dir") === "rtl" ? "rtl" : "ltr";
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.setAttribute("placeholder", t(el.dataset.i18nPlaceholder));
  for (const el of document.querySelectorAll("[data-i18n-title]")) el.setAttribute("title", t(el.dataset.i18nTitle));
  for (const el of document.querySelectorAll("[data-i18n-aria-label]")) el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel));
}

// --- Screens -------------------------------------------------------------------

const SCREENS = ["loading", "connect", "clip", "done", "settings"];

function show(name) {
  for (const s of SCREENS) $(`screen-${s}`).hidden = s !== name;
  $("settings-btn").hidden = name === "loading" || name === "settings";
}

function showError(el, key) {
  el.textContent = key ? t(key) : "";
  el.hidden = !key;
}

// --- Destinations --------------------------------------------------------------

const PAGE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>';
const DB_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10"/></svg>';
const LOCK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

function destRow({ id, kind, title, icon, path }, selected) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "zc-dest";
  b.setAttribute("role", "option");
  b.setAttribute("aria-selected", String(selected));
  b.dataset.test = "dest";
  b.dataset.id = id;
  b.dataset.kind = kind;
  const ic = document.createElement("span");
  ic.className = "zc-dest-icon";
  const emoji = safeIcon(icon);
  if (emoji) ic.textContent = emoji;
  else ic.innerHTML = kind === "private" ? LOCK_ICON : kind === "database" ? DB_ICON : PAGE_ICON;
  const text = document.createElement("span");
  text.className = "zc-dest-text";
  const tt = document.createElement("span");
  tt.className = "zc-dest-title";
  tt.textContent = title || t("untitled");
  text.append(tt);
  if (path) {
    const p = document.createElement("span");
    p.className = "zc-dest-path";
    p.textContent = path;
    text.append(p);
  }
  b.append(ic, text);
  if (kind === "database") {
    const tag = document.createElement("span");
    tag.className = "zc-tag";
    tag.textContent = t("database");
    b.append(tag);
  }
  b.addEventListener("click", () => {
    if (kind === "private") {
      state.target = { type: "private" };
      state.dest = null;
    } else {
      state.target = { type: kind, id };
      state.dest = { id, kind, title, icon, path };
    }
    renderDests();
  });
  return b;
}

function group(label) {
  const g = document.createElement("div");
  g.className = "zc-group";
  g.textContent = label;
  return g;
}

function renderDests() {
  const box = $("dests");
  box.replaceChildren();
  const selId = state.target.type === "private" ? "private" : state.target.id;
  const searching = state.query.trim() !== "";
  if (!searching) {
    box.append(destRow({ id: "private", kind: "private", title: t("destPrivate"), icon: "", path: t("destPrivateHint") }, selId === "private"));
    if (state.recent.length) {
      box.append(group(t("recent")));
      for (const d of state.recent) box.append(destRow(d, d.id === selId));
    }
  }
  const shown = new Set(searching ? [] : state.recent.map((d) => d.id));
  const results = state.results.filter((d) => !shown.has(d.id));
  if (results.length) {
    box.append(group(t("results")));
    for (const d of results) box.append(destRow(d, d.id === selId));
  } else if (searching) {
    const e = document.createElement("div");
    e.className = "zc-empty";
    e.textContent = t("noResults");
    box.append(e);
  }
  // The chosen destination stays visible even when it is not in this list (it was picked from a search).
  if (state.dest && ![...box.querySelectorAll(".zc-dest")].some((b) => b.dataset.id === state.dest.id)) box.prepend(destRow(state.dest, true));
}

async function loadDests() {
  const seq = ++state.seq;
  const res = await ask({ type: "destinations", ws: state.ws, q: state.query });
  if (seq !== state.seq) return;
  if (!res?.ok) {
    if (res?.error === "errUnauthorized") return showConnect();
    showError($("error"), res?.error || "errServer");
    return;
  }
  state.results = (res.results || []).filter((d) => d && (d.kind === "page" || d.kind === "database"));
  state.recent = pushRecent(res.recent, null);
  // The first time this workspace opens: where the last clip went.
  if (state.target.type === "private" && !state.dest && !state.query && res.last?.ws === state.ws && res.last.dest) {
    state.target = res.last.target;
    state.dest = res.last.dest;
  }
  renderDests();
}

let searchTimer = 0;
$("search").addEventListener("input", (e) => {
  state.query = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void loadDests(), 200);
});

$("workspace").addEventListener("change", (e) => {
  state.ws = e.target.value;
  state.target = { type: "private" };
  state.dest = null;
  state.query = "";
  $("search").value = "";
  void ext.storage.local.set({ [`popupWs:${state.server}`]: state.ws });
  void loadDests();
});

// --- Modes ---------------------------------------------------------------------

function setModes(allowed, preferred) {
  for (const r of document.querySelectorAll('input[name="mode"]')) {
    r.disabled = !allowed.includes(r.value);
    r.checked = r.value === (allowed.includes(preferred) ? preferred : allowed[0]);
  }
}

const mode = () => document.querySelector('input[name="mode"]:checked')?.value || "article";

// --- Start ---------------------------------------------------------------------

function showConnect() {
  // Not connected (or no longer): a new token arriving re-opens the clip screen.
  state.user = null;
  $("connect-server").textContent = state.server.replace(/^https:\/\//, "");
  $("connect-wait").hidden = true;
  show("connect");
}

async function init() {
  show("loading");
  const st = await ask({ type: "state" });
  state.server = st.server;
  state.defaultServer = st.defaultServer;
  state.user = st.user;
  if (!st.user) return showConnect();
  state.tabId = testTab ?? (await ext.tabs.query({ active: true, currentWindow: true }))[0]?.id ?? null;
  const [seen, me] = await Promise.all([state.tabId !== null ? ask({ type: "peek", tabId: state.tabId }) : null, ask({ type: "me" })]);
  if (!me?.ok) {
    if (me?.error === "errUnauthorized") return showConnect();
    show("clip");
    showError($("error"), me?.error || "errServer");
    $("save-btn").disabled = true;
    return;
  }
  state.page = seen?.page ?? null;
  state.intent = seen?.intent ?? null;
  state.workspaces = Array.isArray(me.workspaces) ? me.workspaces : [];
  const saved = (await ext.storage.local.get(`popupWs:${state.server}`))[`popupWs:${state.server}`];
  const has = (id) => state.workspaces.some((w) => w.id === id);
  state.ws = (has(saved) && saved) || (has(me.lastWs) && me.lastWs) || state.workspaces.find((w) => w.personal)?.id || state.workspaces[0]?.id || "";
  const sel = $("workspace");
  sel.replaceChildren(...state.workspaces.map((w) => new Option(w.name, w.id, false, w.id === state.ws)));
  sel.hidden = state.workspaces.length < 2;

  const ip = state.intent?.page;
  $("title").value = (ip?.title || state.page?.title || "").slice(0, 300);
  if (ip) setModes([state.intent.mode], state.intent.mode);
  else if (!state.page) setModes(["bookmark"], "bookmark");
  else if (!state.page.scriptable) setModes(["bookmark"], "bookmark");
  else setModes(state.page.hasSelection ? ["article", "bookmark", "selection"] : ["article", "bookmark"], state.intent?.mode || "article");

  show("clip");
  showError($("error"), !state.page && !ip ? "errNoPage" : "");
  $("save-btn").disabled = !state.page && !ip;
  $("title").focus();
  $("title").select();
  await loadDests();
}

// --- Save ----------------------------------------------------------------------

function saving(on) {
  $("save-btn").disabled = on;
  $("save-btn").querySelector(".zc-spinner").hidden = !on;
  $("save-label").textContent = t(on ? "saving" : "save");
}

$("save-btn").addEventListener("click", async () => {
  showError($("error"), "");
  saving(true);
  const res = await ask({
    type: "clip",
    tabId: state.tabId,
    ws: state.ws,
    target: state.target,
    dest: state.dest,
    mode: mode(),
    title: $("title").value.trim(),
    page: state.intent?.page ?? null,
  });
  saving(false);
  if (!res?.ok) {
    if (res?.error === "errUnauthorized") return showConnect();
    showError($("error"), res?.error || "errServer");
    return;
  }
  $("done-dest").textContent = state.dest?.title || t("destPrivate");
  $("open-link").href = res.url;
  show("done");
});

$("done-btn").addEventListener("click", () => window.close());

$("title").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !$("save-btn").disabled) $("save-btn").click();
});

// --- Connect and settings ------------------------------------------------------

$("connect-btn").addEventListener("click", () => {
  // Asked inside the click: Firefox grants host access only at the person's gesture.
  const asked = ext.permissions.request({ origins: [originPattern(state.server)] }).catch(() => true);
  void asked.then(async (granted) => {
    if (!granted) {
      $("connect-wait").textContent = t("errPermission");
      $("connect-wait").hidden = false;
      return;
    }
    $("connect-wait").textContent = t("connectWaiting");
    $("connect-wait").hidden = false;
    await ask({ type: "connect" });
  });
});

ext.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "auth" in changes && changes.auth.newValue && !state.user) void init();
});

function openSettings() {
  $("server").value = state.server;
  $("account").hidden = !state.user;
  $("account-name").textContent = state.user?.name || "";
  showError($("settings-error"), "");
  show("settings");
}

$("settings-btn").addEventListener("click", openSettings);
$("connect-settings").addEventListener("click", openSettings);
$("settings-back").addEventListener("click", () => void init());

$("server-save").addEventListener("click", () => {
  const origin = serverOrigin($("server").value);
  if (!origin) return showError($("settings-error"), "serverInvalid");
  const asked = origin === state.defaultServer ? Promise.resolve(true) : ext.permissions.request({ origins: [originPattern(origin)] }).catch(() => false);
  void asked.then(async (granted) => {
    if (!granted) return showError($("settings-error"), "errPermission");
    const res = await ask({ type: "setServer", server: origin });
    if (!res?.ok) return showError($("settings-error"), res?.error || "errServer");
    await init();
  });
});

$("disconnect-btn").addEventListener("click", async () => {
  await ask({ type: "disconnect" });
  showConnect();
});

localize();
void init();
