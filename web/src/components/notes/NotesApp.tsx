"use client";

// zvena Documents — the shell: loads the local store, syncs the open
// workspace, routes by the URL hash (/docs#Page-title-<id>), and lays out the
// sidebar, top bar, page, side peek, dialogs and toasts. Viewers and
// commenters get the same pages read-only.

import { withWs } from "@/lib/notes/workspace";
import "@blocknote/ariakit/style.css";
import "./notes.css";
import "./theme.css";
import "./round2.css";
import "./suggest.css";
import "./parity.css";
import { NoAccess } from "./NoAccess";
import { CommentsSidebar, useCommentsDocked } from "./Comments";
import { useLiveSites } from "./live-site";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChevronsRight, Menu as MenuIcon, X, Maximize2, SquarePen, Trash2 } from "lucide-react";
import { notesStore } from "@/lib/notes/store";
import { loadPeople, reportTimeZone, setMe } from "@/lib/notes/people";
import { recordView } from "@/lib/notes/history-client";
import { loadCustomEmoji } from "@/lib/notes/emoji";
import { NotesSync, type SyncState } from "@/lib/notes/sync";
import { useNotesT } from "@/lib/notes/i18n";
import { blankSchema, copyNotes, defaultView, displayTitle, iconText, idFromSlug, isSourceNote, noteSlug, orderBetween, sanitizeNote, shortId, STATUS_OPTIONS, treeChildren } from "@/lib/notes/model";
import { databaseOf } from "@/lib/notes/sources";
import { NOTE_LIMITS, type DbView, type Note } from "@/lib/notes/types";
import { NotesContext, storeKey, type NotesApi, type NotesTeamspace, type NotesUser, type OpenOpts } from "./context";
import { atLeastLevel, levelIn } from "@/lib/notes/access-client";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { PageView } from "./PageView";
import { HomeView } from "./HomeView";
import { applyTheme } from "./prefs";
import { NotesShell } from "./NotesShell";
import { showLocalPagesEarly } from "@/lib/notes/boot";
import { dialogsPart, iconsPart, lazyComponent, panelsPart, preloadParts, templatesPart } from "./lazy";
import { Toasts, toast, type Anchor } from "./ui";
import type { NotesKey } from "@/lib/notes/i18n";
import { runAutomations } from "./automations-run";
import { collectReminders, dateTimePart, dueReminders } from "@/lib/notes/reminders";
import { setWorkspace } from "@/lib/notes/workspace";
import { blockOfHash, expectBlock, expectView } from "./block-link";
import { openOnStart } from "./prefs";
import { Shell } from "@/components/zvena/ds";
import { DocsFrameLoading, toShellUser } from "./docs-frame";
import { intlOf, isLocale } from "@/i18n/locales";
import { useAppLaunch } from "./app-launch";
import { translate } from "@/lib/i18n";

// Opened on demand (and preloaded once the app is idle).
const SearchDialog = lazyComponent(panelsPart, (m) => m.SearchDialog);
const SettingsDialog = lazyComponent(panelsPart, (m) => m.SettingsDialog);
const TrashPanel = lazyComponent(panelsPart, (m) => m.TrashPanel);
const MovePanel = lazyComponent(panelsPart, (m) => m.MovePanel);
const TemplatesDialog = lazyComponent(templatesPart, (m) => m.TemplatesDialog);
const ImportDialog = lazyComponent(dialogsPart, (m) => m.ImportDialog);

type Route = { kind: "home" } | { kind: "page"; id: string } | { kind: "start" };

function parseRoute(): Route {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  if (!h) return { kind: "start" };
  if (h === "home") return { kind: "home" };
  // The desktop app's quick search window: Home behind the search dialog (app-launch.ts opens it).
  if (h === "search") return { kind: "home" };
  const id = idFromSlug(h.split(/[?&]/)[0]);
  // A link to a block (…&b=<id>): the page scrolls to it once open.
  if (id) expectBlock(id, blockOfHash(location.hash));
  if (id) expectView(location.hash);
  return id ? { kind: "page", id } : { kind: "home" };
}

const SIDEBAR_W = "nt-sidebar-w";
const SIDEBAR_C = "nt-sidebar-collapsed";

function readNum(key: string, dflt: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : dflt;
  } catch {
    return dflt;
  }
}

/**
 * `initialUser`: who the server saw signed in (undefined when it did not
 * say). A return visit by the same account opens this device's pages at
 * once; the session refresh and sync follow.
 */
export default function NotesApp({ initialUser }: { initialUser?: NotesUser | null }) {
  const store = notesStore();
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { t, locale } = useNotesT();
  const [route, setRoute] = useState<Route>({ kind: "start" });
  const [user, setUser] = useState<NotesUser | null | undefined>(initialUser);
  const [sync, setSync] = useState<SyncState>({ user: null, online: true, syncing: false, error: false });
  const [ready, setReady] = useState(false);
  // Client-only route (ssr: false), so local preferences can seed the state.
  const [width, setWidth] = useState(() => readNum(SIDEBAR_W, 240));
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_C) === "1";
    } catch {
      return false;
    }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  // Closed sidebar hovered at the left edge: it floats over the page (Notion's peek).
  const [sidePeek, setSidePeek] = useState(false);
  const [peekId, setPeekId] = useState<string | null>(null);
  const [peekCenter, setPeekCenter] = useState(false);
  const commentsDocked = useCommentsDocked();
  const [modal, setModal] = useState<"search" | "templates" | "import" | "settings" | null>(null);
  const [settingsTab, setSettingsTab] = useState<"keys" | undefined>(undefined);
  const [pop, setPop] = useState<{ kind: "trash" | "move"; anchor: HTMLElement; id?: string } | null>(null);
  const syncRef = useRef<NotesSync | null>(null);
  const [, setTick] = useState(0);

  // Boot: local store, then the session, then sync.
  useEffect(() => {
    let live = true;
    void (async () => {
      await store.load();
      // This device's pages belong to the account the server saw (or are a
      // guest's, which an account adopts): show them now instead of after the
      // session and sync round trips. Another account's pages wait for sync,
      // which clears them, so they never flash for the wrong person.
      if (initialUser) setWorkspace(initialUser.ws.id);
      const early = showLocalPagesEarly(store.meta.owner, store.meta.seeded, store.all().length, initialUser === undefined ? undefined : storeKey(initialUser));
      if (early && live) setReady(true);
      // A first visit gets the starter page: its template loads alongside the session and sync.
      const starter = store.meta.seeded ? null : templatesPart.load();
      starter?.catch(() => {});
      // The session check (it also refreshes the cookie). undefined: no answer
      // (offline, a hiccup) — then who the server saw when the page loaded is
      // trusted, instead of treating the account as signed out, which made
      // sync drop this device's copy of the account's pages.
      const want = initialUser?.ws.id ?? new URLSearchParams(location.search).get("ws") ?? "";
      const checked = fetch(`/api/auth/session${want ? `?ws=${encodeURIComponent(want)}` : ""}`, { credentials: "same-origin", cache: "no-store" })
        .then(async (r) => {
          const j = (await r.json()) as { user?: NotesUser | null };
          if (!r.ok) throw new Error(String(r.status));
          return j.user?.id && j.user.ws ? j.user : null;
        })
        .catch((): undefined => undefined);
      const begin = async (u: NotesUser | null) => {
        setUser(u);
        // New top-level pages of a member go to their Private (Notion); a guest device keeps its own.
        store.setDefaultSpace(u && u.ws.role !== "guest" ? "private" : undefined);
        const s = new NotesSync(store);
        syncRef.current = s;
        s.subscribe(setSync);
        s.onRejected = () => toast(t("toast.syncFailed"));
        s.onDetached = () => toast(t("toast.otherTab"), { label: t("toast.reload"), run: () => location.reload() }, 20_000);
        if (u) setWorkspace(u.ws.id);
        // Reminders reach the Inbox at this person's local time.
        if (u) reportTimeZone();
        void loadCustomEmoji(u?.ws.id ?? null);
        // Guest documents move into the personal workspace only (never into a shared one).
        await s.start(u ? { key: storeKey(u), ws: u.ws.id, adoptGuest: u.ws.personal, guest: u.ws.role === "guest" } : null);
      };
      let u: NotesUser | null;
      if (initialUser && !early) {
        // Signed in when the page was made, and nothing of theirs on this device
        // to show yet: sync starts now, alongside the check (one round trip to
        // the pages, not two). The check's newer copy (roles, workspaces)
        // replaces it; only an answer naming someone else (signed out, or
        // another account in another tab since) starts over for them. With
        // this device's pages already on screen, sync follows the check as
        // before, which leaves the first paint the main thread.
        u = initialUser;
        // (The same answer changes nothing: no second render of the whole workspace.)
        void checked.then((c) => live && c && storeKey(c) === storeKey(initialUser) && JSON.stringify(c) !== JSON.stringify(initialUser) && setUser(c));
        await begin(u);
        if (!live) return;
        const c = await checked;
        if (!live) return;
        if (c !== undefined && storeKey(c) !== storeKey(initialUser)) {
          syncRef.current?.stop();
          u = c;
          await begin(u);
        }
      } else {
        const c = await checked;
        if (!live) return;
        u = c === undefined ? (initialUser ?? null) : c;
        await begin(u);
      }
      if (!live) return;
      // Trash keeps pages for 30 days (the Trash panel says so), then they go
      // for good — after the pull, and only where the person may delete.
      if (!u || u.ws.role === "owner" || u.ws.role === "editor") {
        const cutoff = Date.now() - 30 * 86_400_000;
        for (const n of store.all()) if (n.trashedAt !== null && n.trashedAt > 0 && n.trashedAt < cutoff && store.get(n.id)) store.destroy(n.id);
      }
      // First visit: the "Getting Started" page (not in someone else's shared workspace).
      if (starter && !store.meta.seeded && (!u || u.ws.personal)) {
        try {
          if (store.all().length === 0) {
            const { TEMPLATES, instantiateTemplate } = await starter;
            const tpl = TEMPLATES.find((x) => x.key === "getStarted");
            if (tpl) instantiateTemplate(tpl, locale, store, null);
          }
          store.saveMeta({ seeded: true });
        } catch {
          // Offline on the very first visit: the starter page comes next time.
        }
      }
      if (!live) return;
      if (!early) setReady(true);
    })();
    const onHash = () => setRoute(parseRoute());
    window.addEventListener("hashchange", onHash);
    window.addEventListener("popstate", onHash);
    // zvena's Settings links here with ?settings: Documents' own settings open (and the link is tidied).
    const u = new URL(location.href);
    if (u.searchParams.has("settings")) {
      u.searchParams.delete("settings");
      history.replaceState(history.state, "", u.toString());
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setModal("settings");
    } else if (u.searchParams.has("import")) {
      // …and the rail's "Import" (its Try block, as Linear's "Import issues") with ?import.
      u.searchParams.delete("import");
      history.replaceState(history.state, "", u.toString());
      setModal("import");
    }
    const onUnload = () => {
      // A request started now is cut off with the page; the keepalive one is not.
      syncRef.current?.sendOnUnload();
      void store.flush();
      void syncRef.current?.push();
    };
    window.addEventListener("pagehide", onUnload);
    const onTheme = () => setTick((x) => x + 1);
    window.addEventListener("nt-theme", onTheme);
    return () => {
      live = false;
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("popstate", onHash);
      window.removeEventListener("pagehide", onUnload);
      window.removeEventListener("nt-theme", onTheme);
      const s = syncRef.current;
      s?.stop();
      // Left for another section without a page load (the rail routes on the
      // client): the editor saves its last keystrokes as it unmounts, after
      // this, so a moment later what is pending goes out, as a page close sends it.
      if (s) setTimeout(() => void s.pushOnce().catch(() => {}), 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Members (Person properties, @mentions, "Me" in filters): the workspace's
  // list again when it changes, and on focus at most every 5 minutes.
  const wsId = user?.ws.id ?? null;
  useEffect(() => {
    setMe(user?.id);
  }, [user?.id]);
  useEffect(() => {
    if (!wsId) return;
    let last = Date.now();
    void loadPeople(wsId);
    const onFocus = () => {
      if (Date.now() - last < 5 * 60_000) return;
      last = Date.now();
      void loadPeople(wsId);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [wsId]);

  // "Duplicate" on a public page lands here as #dup=<share id>: copy it in and open it.
  useEffect(() => {
    if (!ready) return;
    const m = /^#dup=([A-Za-z0-9]{16,40})$/.exec(location.hash);
    if (!m) return;
    history.replaceState(null, "", "/docs#home");
    // Viewers and commenters cannot add pages to the workspace.
    if (user && (user.ws.role === "viewer" || user.ws.role === "commenter")) {
      toast(t("ro.banner", { role: t(`ro.role.${user.ws.role}`), comment: user.ws.role === "commenter" ? t("ro.comment") : "" }));
      return;
    }
    void (async () => {
      try {
        const res = await fetch(`/api/notes/share?id=${m[1]}`);
        if (res.status === 403) {
          toast(t("dup.off"));
          return;
        }
        const j = (await res.json()) as { snapshot?: { notes: Note[]; rootId: string } };
        if (!res.ok || !j.snapshot?.notes?.length) throw new Error(String(res.status));
        const copy = copyNotes(j.snapshot.notes.map((n) => sanitizeNote(n)).filter((n): n is Note => n !== null), j.snapshot.rootId);
        // The copy starts in the person's Private, as Notion's "Duplicate" from a public page.
        for (const n of copy.notes) store.put(n.id === copy.rootId && user ? { ...n, space: "private" } : n);
        const root = store.get(copy.rootId);
        if (root) {
          history.replaceState(null, "", `/docs#${noteSlug(root)}`);
          setRoute({ kind: "page", id: root.id });
        }
        toast(t("dup.done"));
      } catch {
        toast(t("dup.failed"));
      }
    })();
  }, [ready, store, t, user]);

  // "Use this template" on zvena's template gallery (/templates)
  // lands here as #tpl=<template key>/<language>: add a copy and open it.
  useEffect(() => {
    if (!ready) return;
    const m = /^#tpl=([A-Za-z]{2,40})(?:\/([a-z]{2}))?$/.exec(location.hash);
    if (!m) return;
    // Viewers and commenters cannot add pages to the workspace.
    if (user && (user.ws.role === "viewer" || user.ws.role === "commenter")) {
      history.replaceState(null, "", "/docs#home");
      return;
    }
    history.replaceState(null, "", "/docs#home");
    void (async () => {
      try {
        const { TEMPLATES, instantiateTemplate } = await templatesPart.load();
        const tpl = TEMPLATES.find((x) => x.key === m[1]);
        if (!tpl) {
          setRoute({ kind: "home" });
          toast(t("tpl.missing"));
          return;
        }
        const root = instantiateTemplate(tpl, isLocale(m[2]) ? m[2] : locale, store, null);
        history.replaceState(null, "", `/docs#${noteSlug(root)}`);
        setRoute({ kind: "page", id: root.id });
        toast(t("tpl.added"));
      } catch {
        toast(t("tpl.missing"));
      }
    })();
  }, [ready, store, t, locale, user]);

  // "New document" on zvena's Home lands here as #new.
  useEffect(() => {
    if (!ready || location.hash !== "#new") return;
    if (user && (user.ws.role === "viewer" || user.ws.role === "commenter")) {
      history.replaceState(null, "", "/docs#home");
      return;
    }
    const n = store.create({ kind: "page", parentId: null, title: "" });
    history.replaceState(null, "", `/docs#${noteSlug(n)}`);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRoute({ kind: "page", id: n.id });
  }, [ready, store, user]);

  // Resolve the start route once the store is ready: last visited page, else Home.
  useEffect(() => {
    if (!ready) return;
    if (/^#(dup|tpl)=/.test(location.hash) || location.hash === "#new") return;
    const r = parseRoute();
    if (r.kind !== "start") {
      // The route comes from the URL, which only exists once mounted.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRoute(r);
      return;
    }
    // Notion's "Open on start" (Settings): the last visited page, Home, or the sidebar's first page.
    const start = openOnStart();
    const last = start === "last" ? store.meta.recent.find((x) => store.get(x.id) && !store.isTrashed(x.id)) : undefined;
    const first = start === "home" ? undefined : treeChildren(null, store.getSnapshot().list, store.getSnapshot().byId)[0];
    const target = last?.id ?? first?.id;
    if (target) {
      const n = store.get(target) as Note;
      history.replaceState(null, "", `/docs#${noteSlug(n)}`);
      setRoute({ kind: "page", id: target });
    } else {
      history.replaceState(null, "", "/docs#home");
      setRoute({ kind: "home" });
    }
  }, [ready, store]);

  const routeNote = route.kind === "page" ? snap.byId.get(route.id) : undefined;
  // A data source opens as its database (Notion has no page for a data source).
  const current = databaseOf(routeNote, snap.byId);
  const currentId = route.kind === "page" ? (current?.id ?? route.id) : null;

  // Remember visits; keep the hash slug in step with the title; the tab title.
  // Leaving a page checkpoints it into the page history.
  useEffect(() => {
    if (!current) {
      document.title = route.kind === "home" ? `${t("side.home")} · ${t("app.name")}` : t("app.name");
      return;
    }
    const id = current.id;
    store.visit(id);
    const onHide = () => store.checkpoint(id);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      store.checkpoint(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);
  // Page analytics: a member opening a page counts as a view.
  const viewWs = user?.ws.id;
  const viewId = current?.id;
  useEffect(() => {
    if (viewWs && viewId) recordView(viewWs, viewId);
  }, [viewWs, viewId]);
  useEffect(() => {
    if (!current) return;
    document.title = `${iconText(current.icon) ? `${iconText(current.icon)} ` : ""}${displayTitle(current, t("page.untitled"))}`;
    const slug = noteSlug(current);
    if (decodeURIComponent(location.hash.slice(1)) !== slug) history.replaceState(null, "", `/docs#${slug}`);
    // Expand the path to the open page in the sidebar.
    let p = current.parentId ? snap.byId.get(current.parentId) : undefined;
    const seen = new Set<string>();
    while (p && !seen.has(p.id)) {
      seen.add(p.id);
      if (p.kind === "page" && !store.meta.expanded.includes(p.id)) store.setExpanded(p.id, true);
      p = p.parentId ? snap.byId.get(p.parentId) : undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, current?.title, current?.icon]);

  const open = useCallback(
    (id: string, opts?: OpenOpts) => {
      const found = store.get(id);
      if (!found) return;
      // A data source opens as its database.
      const n = databaseOf(found, store.getSnapshot().byId) ?? found;
      id = n.id;
      const parent = n.parentId ? store.get(n.parentId) : undefined;
      if (opts?.peek && parent?.kind === "database") {
        setPeekId(id);
        setPeekCenter(opts.peek === "center");
        return;
      }
      setPeekId(null);
      setMobileOpen(false);
      expectBlock(id, opts?.block);
      const url = `/docs#${noteSlug(n)}`;
      if (opts?.replace) history.replaceState(null, "", url);
      else history.pushState(null, "", url);
      setRoute({ kind: "page", id });
      document.querySelector(".nt-scroller")?.scrollTo({ top: 0 });
    },
    [store]
  );

  const goHome = useCallback(() => {
    setPeekId(null);
    history.pushState(null, "", "/docs#home");
    setRoute({ kind: "home" });
  }, []);

  // Date reminders fire while Notes is open: a toast, and a system notification when allowed and hidden.
  useEffect(() => {
    if (!ready) return;
    const KEY = "nt-reminders-shown";
    const check = () => {
      let shown: Set<string>;
      try {
        shown = new Set(JSON.parse(localStorage.getItem(KEY) || "[]") as string[]);
      } catch {
        shown = new Set();
      }
      const snap = store.getSnapshot();
      const due = dueReminders(collectReminders(snap.byId.values(), (id) => snap.byId.get(id)?.db), Date.now(), shown);
      for (const r of due) {
        shown.add(r.key);
        const n = snap.byId.get(r.noteId);
        if (!n) continue;
        const page = displayTitle(n, t("page.untitled"));
        // What it is about: the to-do's words ("Visit to the doctor"), else the page or row.
        const subject = (r.text ?? "").split(" · ")[0]?.trim() || page;
        const time = dateTimePart(r.date);
        const date = `${new Date(`${r.date.slice(0, 10)}T00:00:00`).toLocaleDateString(intlOf(locale), { day: "numeric", month: "long" })}${time ? `, ${time}` : ""}`;
        toast(t("remind.fired", { page: subject, date }), n.synced ? undefined : { label: t("remind.open"), run: () => open(n.id) });
        if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.visibilityState !== "visible") {
          // A system notification from this tab (no push service: nothing leaves the browser).
          try {
            const note = new Notification(subject, { body: [date, subject === page ? "" : page].filter(Boolean).join(" · "), tag: r.key });
            note.onclick = () => {
              window.focus();
              if (!n.synced) open(n.id);
              note.close();
            };
          } catch {
            // Some mobile browsers only notify through a service worker: the toast above stays.
          }
        }
      }
      if (due.length) {
        try {
          localStorage.setItem(KEY, JSON.stringify([...shown].slice(-500)));
        } catch {
          // Private mode: a reminder may show again after a reload.
        }
      }
    };
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, [ready, store, t, locale, open]);

  // Database automations of a signed-in workspace run on the server (every
  // member's edits, forms, schedules); a guest's local-only pages run them here.
  const guest = user === null;
  useEffect(() => (guest ? runAutomations(store, (name) => toast(t("auto.ran", { name: name || t("auto.untitled") }))) : undefined), [guest, store, t]);
  // Once the workspace is on screen, the rest of Notes loads in the background.
  useEffect(() => (ready ? preloadParts() : undefined), [ready]);
  // Pages with a monochrome icon: their icon set loads at once (others get it with the idle preload).
  useEffect(() => {
    if (ready && store.all().some((n) => n.icon?.startsWith("icon:"))) iconsPart.load().catch(() => {});
  }, [ready, store]);

  // A top-level page's sidebar section (Notion): Private unless the caller names one ("" = the workspace's pages).
  const spaceFor = useCallback(
    (parentId: string | null, space: string | undefined): { space?: string } => {
      if (parentId || !user) return {};
      return { space: space ?? "private" };
    },
    [user]
  );

  const newPage = useCallback<NotesApi["newPage"]>(
    (parentId = null, opts) => {
      const n = store.create({ kind: "page", parentId, title: opts?.title ?? "", icon: opts?.icon ?? "", content: opts?.content ?? [], inline: opts?.inline, ...spaceFor(parentId, opts?.space) });
      // A sub-page also appears in its parent's body (unless the caller places it).
      if (parentId && !opts?.stay) {
        const parent = store.get(parentId);
        if (parent?.kind === "page") store.update(parentId, { content: [...parent.content, { type: "page", props: { noteId: n.id } }] });
      }
      if (!opts?.stay) open(n.id);
      return n;
    },
    [open, spaceFor, store]
  );

  const newDatabase = useCallback<NotesApi["newDatabase"]>(
    (parentId, opts) => {
      const schema = blankSchema({ name: t("db.name"), tags: t("db.tags"), table: t("db.table") });
      const type: DbView["type"] = opts?.view ?? "table";
      if (type === "board" || type === "chart") schema.properties.push({ id: shortId(), name: t("db.status"), type: "status", options: STATUS_OPTIONS.map((o) => ({ ...o, name: t(`status.${o.id}` as NotesKey) })) });
      if (type === "calendar" || type === "timeline") schema.properties.push({ id: shortId(), name: t("db.date"), type: "date" });
      // A new form starts with one question: the respondent's name (the title).
      if (type === "form") schema.properties = [{ ...schema.properties[0], name: t("form.nameQuestion") }];
      if (type !== "table") schema.views = [defaultView(type, t(`db.${type}` as NotesKey), schema)];
      const db = store.create({ kind: "database", parentId, title: opts?.title ?? "", db: schema, inline: opts?.inline || undefined, ...spaceFor(parentId, opts?.space) });
      // Three empty rows, as Notion starts a table (a board puts them in its first column).
      const first = type === "board" ? schema.properties.find((p) => p.type === "status") : undefined;
      if (type === "table" || type === "board") for (let i = 0; i < 3; i++) store.create({ kind: "page", parentId: db.id, props: first?.options?.[0] ? { [first.id]: first.options[0].id } : {} });
      if (!opts?.stay) open(db.id);
      return db;
    },
    [open, spaceFor, store, t]
  );

  const newRow = useCallback<NotesApi["newRow"]>(
    (dbId, opts) => {
      const rows = store.all().filter((n) => n.parentId === dbId && n.trashedAt === null && !n.template && !isSourceNote(n)).sort((a, b) => a.order - b.order);
      const order = opts?.first ? orderBetween(undefined, rows[0]?.order) : orderBetween(rows[rows.length - 1]?.order, undefined);
      // A new page in a wiki is owned by whoever adds it (Notion).
      const owner = store.get(dbId)?.db?.wiki?.owner;
      const props = owner && user && !(owner in (opts?.props ?? {})) ? { ...(opts?.props ?? {}), [owner]: [user.id] } : (opts?.props ?? {});
      const n = store.create({ kind: "page", parentId: dbId, title: opts?.title ?? "", props, order });
      if (!opts?.stay) setPeekId(n.id);
      return n;
    },
    [store, user]
  );

  const trash = useCallback(
    (id: string) => {
      const n = store.get(id);
      if (!n) return;
      store.trash(id);
      if (peekId === id) setPeekId(null);
      toast(t("toast.trashed"), { label: t("toast.undo"), run: () => store.restore(id) });
    },
    [peekId, store, t]
  );

  const relocate = useCallback(
    (id: string, parentId: string | null, beforeId?: string | null, space?: string) => {
      const note = store.get(id);
      if (!note) return;
      const oldParent = note.parentId;
      store.move(id, parentId, beforeId ?? null, space);
      if (oldParent === parentId) return;
      // Notion keeps sub-pages in the body: a block in the new parent, none in the old.
      if (parentId) {
        const parent = store.get(parentId);
        if (parent?.kind === "page" && !(parent.content as { props?: { noteId?: string } }[]).some((b) => b?.props?.noteId === id)) {
          store.update(parentId, { content: [...parent.content, { type: note.kind === "database" && note.inline ? "database" : "page", props: { noteId: id } }] });
        }
      }
      if (oldParent) {
        const old = store.get(oldParent);
        if (old?.kind === "page") {
          const strip = (blocks: unknown[]): unknown[] =>
            blocks
              .filter((b) => (b as { props?: { noteId?: string } })?.props?.noteId !== id)
              .map((b) => {
                const bb = b as { children?: unknown[] };
                return Array.isArray(bb.children) ? { ...bb, children: strip(bb.children) } : b;
              });
          store.update(old.id, { content: strip(old.content) });
        }
      }
    },
    [store]
  );

  const duplicate = useCallback(
    (id: string) => {
      const copy = store.duplicate(id, t("menu.copySuffix"));
      if (!copy) return;
      // A duplicated sub-page gets its own block right after the original's.
      if (copy.parentId) {
        const parent = store.get(copy.parentId);
        if (parent?.kind === "page") {
          const idx = (parent.content as { props?: { noteId?: string } }[]).findIndex((b) => b?.props?.noteId === id);
          const block = { type: "page", props: { noteId: copy.id } };
          const content = [...parent.content];
          if (idx >= 0) content.splice(idx + 1, 0, block);
          else content.push(block);
          store.update(parent.id, { content });
        }
      }
      toast(t("toast.duplicated"));
      const parent = copy.parentId ? store.get(copy.parentId) : undefined;
      if (parent?.kind !== "database") open(copy.id);
    },
    [open, store, t]
  );

  const copyLink = useCallback(
    (id: string) => {
      const n = store.get(id);
      if (!n) return;
      // With the workspace, so a teammate whose last workspace is another one opens the page too.
      void navigator.clipboard?.writeText(`${location.origin}${withWs("/docs")}#${noteSlug(n)}`).catch(() => undefined);
      toast(t("page.copyLinkDone"));
    },
    [store, t]
  );

  const upload = useCallback(
    async (file: File): Promise<string> => {
      if (file.size > NOTE_LIMITS.uploadBytes) {
        toast(t("toast.tooLarge", { mb: Math.round(NOTE_LIMITS.uploadBytes / 1024 / 1024) }));
        throw new Error("too large");
      }
      const res = await fetch(withWs("/api/notes/upload"), {
        method: "POST",
        headers: { "content-type": file.type || "application/octet-stream", "x-file-name": encodeURIComponent(file.name || "file") },
        body: file,
      });
      if (!res.ok) {
        // Without an account only pictures, within a small allowance: say so instead of "failed".
        const why = (await res.json().catch(() => null)) as { signIn?: boolean } | null;
        toast(t(why?.signIn ? "toast.uploadSignIn" : "toast.uploadFailed"));
        throw new Error(`upload ${res.status}`);
      }
      const j = (await res.json()) as { url: string };
      return j.url;
    },
    [t]
  );

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(SIDEBAR_C, c ? "0" : "1");
      } catch {
        // ignore
      }
      return !c;
    });
  }, []);

  const readOnly = Boolean(user && (user.ws.role === "viewer" || user.ws.role === "commenter" || user.ws.role === "guest"));
  // Opened from outside: quick search, shared and opened files, the desktop app's links.
  const openSearch = useCallback(() => setModal("search"), []);
  const openPage = useCallback((id: string) => setRoute({ kind: "page", id }), []);
  useAppLaunch({ ready, store, upload, readOnly, openSearch, openPage, t });
  // Teamspaces of the workspace (members only; guests see just what was shared with them).
  const [loadedTeamspaces, setTeamspaces] = useState<{ ws: string; list: NotesTeamspace[] } | null>(null);
  const [tsTick, setTsTick] = useState(0);
  const isMember = Boolean(user && user.ws.role !== "guest");
  useEffect(() => {
    if (!wsId || !isMember) return;
    let live = true;
    void fetch(`/api/notes/teamspaces?ws=${encodeURIComponent(wsId)}`, { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ teamspaces: NotesTeamspace[] }>) : null))
      .then((j) => live && j && setTeamspaces({ ws: wsId, list: j.teamspaces }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [isMember, wsId, tsTick]);
  const teamspaces = useMemo(() => (isMember && loadedTeamspaces?.ws === wsId ? loadedTeamspaces.list : []), [isMember, loadedTeamspaces, wsId]);
  const reloadTeamspaces = useCallback(() => setTsTick((x) => x + 1), []);
  const me = useMemo(() => (user ? { id: user.id, role: user.ws.role } : null), [user]);
  const levelOf = useCallback((id: string) => levelIn(id, snap.byId, me), [me, snap.byId]);
  const api = useMemo<NotesApi>(
    () => ({
      t,
      locale,
      store,
      snap,
      user,
      currentId,
      open,
      goHome,
      newPage,
      newDatabase,
      newRow,
      trash,
      relocate,
      duplicate,
      copyLink,
      openSearch: () => setModal("search"),
      openTemplates: () => setModal("templates"),
      openImport: () => setModal("import"),
      openSettings: (tab?: "keys") => {
        setSettingsTab(tab === "keys" ? "keys" : undefined);
        setModal("settings");
      },
      openTrash: (anchor: Anchor) => anchor instanceof HTMLElement && setPop({ kind: "trash", anchor }),
      openMove: (id: string, anchor: Anchor) => anchor instanceof HTMLElement && setPop({ kind: "move", anchor, id }),
      upload,
      signIn: () => {
        location.href = `/signin?next=${encodeURIComponent(`/docs${location.hash}`)}`;
      },
      readOnly,
      canComment: !user || user.ws.role !== "viewer",
      levelOf,
      canEdit: (id: string) => atLeastLevel(levelOf(id), "edit"),
      teamspaces,
      reloadTeamspaces,
      syncNow: () => void syncRef.current?.pull(),
      flush: async () => {
        await syncRef.current?.push();
      },
      peekId,
      closePeek: () => setPeekId(null),
    }),
    [copyLink, currentId, duplicate, goHome, levelOf, locale, newDatabase, newPage, newRow, open, peekId, readOnly, relocate, reloadTeamspaces, snap, store, t, teamspaces, trash, upload, user]
  );
  // Published pages stay current: a quiet republish after edits (live-site.ts).
  useLiveSites(api);

  // Keyboard shortcuts (Notion's): ⌘P search of these pages (⌘K is zvena's palette, the
  // whole workspace: components/eco), ⌘\ sidebar, ⌘⇧L theme, ⌘⌥N new page, Esc closes the peek,
  // ⌘[ / ⌘] back and forward, ⌘⇧U the parent page, ⌘⇧P move the page, ⌘/ outside a page's text: the shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const typing = (e.target as HTMLElement | null)?.closest?.("input, textarea, select");
      if (mod && !e.shiftKey && !e.altKey && (e.code === "BracketLeft" || e.code === "BracketRight") && !typing) {
        e.preventDefault();
        if (e.code === "BracketLeft") history.back();
        else history.forward();
        return;
      }
      if (mod && e.shiftKey && !e.altKey && e.code === "KeyU" && currentId) {
        const parent = store.get(currentId)?.parentId;
        if (parent && store.get(parent)) {
          e.preventDefault();
          open(parent);
        }
        return;
      }
      if (mod && e.shiftKey && !e.altKey && e.code === "KeyP" && currentId && !readOnly) {
        const anchor = document.querySelector<HTMLElement>(".nt-topbar .nt-top-actions");
        if (anchor && atLeastLevel(levelOf(currentId), "edit")) {
          e.preventDefault();
          setPop({ kind: "move", anchor, id: currentId });
        }
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && (e.key === "/" || e.code === "Slash") && !(e.target as HTMLElement | null)?.closest?.(".bn-editor")) {
        e.preventDefault();
        setSettingsTab("keys");
        setModal("settings");
        return;
      }
      if (mod && (e.key === "p" || e.key === "P" || (!user && (e.key === "k" || e.key === "K"))) && !e.shiftKey) {
        e.preventDefault();
        setModal((m) => (m === "search" ? null : "search"));
      } else if (mod && e.key === "\\") {
        e.preventDefault();
        if (window.innerWidth < 768) setMobileOpen((v) => !v);
        else toggleCollapsed();
      } else if (mod && e.shiftKey && (e.key === "l" || e.key === "L")) {
        e.preventDefault();
        applyTheme(document.documentElement.classList.contains("dark") ? "light" : "dark");
      } else if (mod && e.altKey && (e.key === "n" || e.key === "N" || e.code === "KeyN")) {
        e.preventDefault();
        if (!readOnly) newPage(null);
      } else if (e.key === "Escape" && peekId && !document.querySelector(".nt-popover, .nt-modal")) {
        setPeekId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentId, levelOf, newPage, open, peekId, readOnly, store, toggleCollapsed, user]);

  const peek = peekId ? snap.byId.get(peekId) : undefined;
  const inTrash = current ? store.isTrashed(current.id) : false;

  if (!ready || !snap.ready) {
    // The same shell the server sent, until this device's pages are read.
    const who = user ?? initialUser ?? null;
    if (who) return <DocsFrameLoading user={who} />;
    return (
      <NotesShell
        user={who}
        labels={{
          notes: t("app.notesShort"),
          newPage: t("side.newPage"),
          search: t("side.search"),
          home: t("side.home"),
          templates: t("side.templates"),
          apps: { home: t("side.zhome"), docs: t("app.notesShort"), projects: t("side.projects"), calendar: translate(locale, "nav.calendar"), mail: translate(locale, "nav.mail"), design: t("side.board"), templates: t("side.ztemplates"), team: t("side.team") },
          pages: t("side.private"),
          guest: t("app.workspaceGuest"),
          sync: who ? t("side.syncOn") : t("side.syncOff"),
          settings: t("side.settings"),
          trash: t("side.trash"),
          help: t("side.help"),
          appsTitle: t("side.apps"),
        }}
      />
    );
  }

  // Signed in: Documents sit in zvena's shared frame (the rail every section
  // shares), with their own block in it; inside the page everything is Notion's.
  // A guest without an account keeps Documents' own sidebar.
  const shellUser = user ? toShellUser(user) : null;
  const work = (
    <>
      <main className="nt-main">
        <div style={{ display: "flex", alignItems: "center" }}>
          {/* Phones: the drawer; a closed sidebar on a wide screen: open it (hover peeks it out).
              In zvena's frame (signed in) the frame has its own menu button: no second one. */}
          {!shellUser && (
            <button
              type="button"
              className="nt-icon-btn nt-btn-reset nt-mobile-menu"
              aria-label={t("side.expand")}
              title={t("side.expand")}
              onMouseEnter={() => collapsed && window.innerWidth >= 768 && setSidePeek(true)}
              onClick={() => {
                if (window.innerWidth < 768) setMobileOpen(true);
                else {
                  setSidePeek(false);
                  toggleCollapsed();
                }
              }}
            >
              {collapsed ? <ChevronsRight className="nt-open-side" /> : null}
              <MenuIcon className="nt-open-menu" />
            </button>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <Topbar note={current ?? null} title={route.kind === "home" ? t("side.home") : ""} />
          </div>
        </div>
        {current && inTrash && (
          <div className="nt-banner">
            <span>{t("page.inTrash")}</span>
            {!readOnly && (
              <>
                <button type="button" className="nt-btn-reset" onClick={() => store.restore(current.trashedAt !== null ? current.id : rootTrashed(current.id))}>
                  {t("page.restore")}
                </button>
                <button
                  type="button"
                  className="nt-btn-reset"
                  onClick={() => {
                    if (window.confirm(t("trash.confirm"))) {
                      const id = current.trashedAt !== null ? current.id : rootTrashed(current.id);
                      store.destroy(id);
                      goHome();
                    }
                  }}
                >
                  {t("page.deleteForever")}
                </button>
              </>
            )}
          </div>
        )}
        {user && (user.ws.role === "viewer" || user.ws.role === "commenter") && (
          <div className="nt-banner nt-banner-info">
            <span>{t("ro.banner", { role: t(`ro.role.${user.ws.role}`), comment: user.ws.role === "commenter" ? t("ro.comment") : "" })}</span>
          </div>
        )}
        {user === null && <GuestBanner onSignIn={api.signIn} />}
        <div className="nt-work">
          <div className="nt-scroller">
            {route.kind === "home" && <HomeView />}
            {route.kind === "page" && current && <PageView key={current.id} note={current} />}
            {route.kind === "page" && !current && user && <NoAccess key={route.id} noteId={route.id} onHome={goHome} />}
            {route.kind === "page" && !current && !user && (
              <div className="nt-home" style={{ textAlign: "center" }}>
                <h1>{t("page.notFound")}</h1>
                <p style={{ color: "var(--nt-text-2)" }}>{t("page.notFoundHint")}</p>
                <button type="button" className="nt-btn nt-btn-primary nt-btn-reset" onClick={goHome}>
                  {t("page.goHome")}
                </button>
              </div>
            )}
          </div>
          {commentsDocked && route.kind === "page" && current && current.kind !== "database" && <CommentsSidebar note={current} />}
        </div>
      </main>
      {peek && (
        <>
          <div className="nt-peek-scrim" data-center={peekCenter || undefined} onMouseDown={() => setPeekId(null)} />
          <div className="nt-peek" data-center={peekCenter || undefined} role="dialog" aria-label={displayTitle(peek, t("page.untitled"))}>
            <div className="nt-peek-bar">
              {!peekCenter && (
                <button type="button" className="nt-icon-btn nt-btn-reset" aria-label={t("common.close")} onClick={() => setPeekId(null)}>
                  <ChevronsRight />
                </button>
              )}
              <button type="button" className="nt-icon-btn nt-btn-reset" aria-label={t("db.openAsPage")} title={t("db.openAsPage")} onClick={() => open(peek.id)}>
                <Maximize2 />
              </button>
              <span style={{ flex: 1 }} />
              {!readOnly && (
                <button type="button" className="nt-icon-btn nt-btn-reset" aria-label={t("menu.delete")} title={t("menu.delete")} onClick={() => trash(peek.id)}>
                  <Trash2 />
                </button>
              )}
              <button type="button" className="nt-icon-btn nt-btn-reset" aria-label={t("common.close")} onClick={() => setPeekId(null)}>
                <X />
              </button>
            </div>
            <div className="nt-peek-scroll">
              <PageView key={peek.id} note={peek} peek />
            </div>
          </div>
        </>
      )}
      {modal === "search" && <SearchDialog onClose={() => setModal(null)} />}
      {modal === "templates" && <TemplatesDialog onClose={() => setModal(null)} />}
      {modal === "import" && <ImportDialog onClose={() => setModal(null)} />}
      {modal === "settings" && <SettingsDialog tab={settingsTab} onClose={() => (setModal(null), setSettingsTab(undefined))} />}
      {pop?.kind === "trash" && <TrashPanel anchor={pop.anchor} onClose={() => setPop(null)} />}
      {pop?.kind === "move" && pop.id && <MovePanel id={pop.id} anchor={pop.anchor} onClose={() => setPop(null)} />}
      <Toasts />
    </>
  );
  if (shellUser) {
    return (
      <NotesContext.Provider value={api}>
        <Shell
          user={shellUser}
          section="docs"
          fill
          sectionNav={
            <Sidebar
              rail
              width={width}
              onWidth={setWidth}
              collapsed={false}
              onCollapse={() => {}}
              mobileOpen={false}
              onMobileClose={() => {}}
              view={route.kind === "home" ? "home" : "page"}
              sync={sync}
            />
          }
          sectionAction={
            !readOnly ? (
              <button type="button" aria-label={t("side.newPage")} title={t("side.newPage")} onClick={() => newPage(null)}>
                <SquarePen />
              </button>
            ) : undefined
          }
        >
          <div className="nt-root nt-in-shell">{work}</div>
        </Shell>
      </NotesContext.Provider>
    );
  }

  return (
    <NotesContext.Provider value={api}>
      <div className="nt-root" data-side-closed={collapsed || undefined}>
        {collapsed && !sidePeek && <div className="nt-peek-zone" onMouseEnter={() => setSidePeek(true)} />}
        <Sidebar
          width={width}
          onWidth={(w) => {
            setWidth(w);
            try {
              localStorage.setItem(SIDEBAR_W, String(w));
            } catch {
              // ignore
            }
          }}
          collapsed={collapsed}
          onCollapse={toggleCollapsed}
          mobileOpen={mobileOpen}
          onMobileClose={() => setMobileOpen(false)}
          peek={sidePeek}
          onPeekEnd={() => setSidePeek(false)}
          view={route.kind === "home" ? "home" : "page"}
          sync={sync}
        />
        {work}
      </div>
    </NotesContext.Provider>
  );

  function rootTrashed(id: string): string {
    let cur = store.get(id);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      if (cur.trashedAt !== null) return cur.id;
      seen.add(cur.id);
      cur = cur.parentId ? store.get(cur.parentId) : undefined;
    }
    return id;
  }
}

/** A guest's reminder: documents live in this browser; uploads are kept while they visit. */
function GuestBanner({ onSignIn }: { onSignIn: () => void }) {
  const { t, locale } = useNotesT();
  const [info, setInfo] = useState<{ files: number; removeAt: number | null; ttlDays: number } | null>(null);
  useEffect(() => {
    void fetch("/api/guest", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ files: number; removeAt: number | null; ttlDays: number }>) : null))
      .then(setInfo)
      .catch(() => undefined);
  }, []);
  const date = info?.removeAt ? new Date(info.removeAt).toLocaleDateString(intlOf(locale), { day: "numeric", month: "long" }) : null;
  return (
    <div className="nt-banner nt-banner-info">
      <span>{date ? t("guest.warn", { date }) : t("guest.banner", { days: info?.ttlDays ?? 30 })}</span>
      <button type="button" className="nt-btn-reset" onClick={onSignIn}>
        {t("side.signIn")}
      </button>
    </div>
  );
}
