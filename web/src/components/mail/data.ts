"use client";

// Mail in the browser: one store for the page (what the server said, the
// lists seen, the open conversation, the selection, open composers), the API
// calls, and actions applied to the list at once (the server and then the
// mail server follow; a failure puts the list back). The live channel is
// the workspace's pulse ("mail" pokes reach the mailbox's owner only).

import { useSyncExternalStore } from "react";
import { pulse, pulseHeaders } from "@/lib/pulse/client";
import type { Draft, MailAccount, MailLabel, MailPrefs, MailSnippet, MailThread, MailView, OutboxItem, ThreadSummary } from "@/lib/mail-client/types";
import { toast } from "@/components/zvena/ds";
import { mt } from "./i18n";

export interface Boot {
  me: { id: string; name: string; email?: string };
  accounts: MailAccount[];
  labels: MailLabel[];
  views: MailView[];
  prefs: MailPrefs;
  snippets: MailSnippet[];
  drafts: Draft[];
  outbox: OutboxItem[];
  counts: { inbox: number; spam: number; drafts: number };
  /** A test stand: its local test server may be used without TLS. */
  stand?: boolean;
}

/** What the list shows: a view, a label or a search (and maybe one mailbox). */
export interface ListRef {
  view?: string;
  label?: string;
  q?: string;
}

export interface Route {
  list: ListRef;
  thread?: string;
  settings?: boolean;
}

export interface ListState {
  threads: ThreadSummary[];
  more: boolean;
  loading: boolean;
  error?: number;
}

export interface ComposerState {
  /** The draft's id (also the composer's). */
  id: string;
  draft: Draft;
  /** Docked under its conversation (a reply) or a window of its own. */
  inline: boolean;
  /** Forwarding: the original's attachments that go along. */
  forward?: string[];
  /** The message replied to or forwarded: quoted, folded, under the text. */
  quoteOf?: string;
  minimized?: boolean;
}

interface State {
  ws: string;
  boot: Boot | null;
  bootError: number | null;
  route: Route;
  lists: Record<string, ListState>;
  threads: Record<string, MailThread | null | undefined>;
  selected: string[];
  focused: string | null;
  composers: ComposerState[];
  live: boolean;
  /** Save to Documents / Turn into issue, for the open conversation. */
  dialog: "docs" | "issue" | null;
}

let state: State = { ws: "", boot: null, bootError: null, route: { list: { view: "inbox" } }, lists: {}, threads: {}, selected: [], focused: null, composers: [], live: false, dialog: null };
const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useMail<T>(pick: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => pick(state), () => pick(state));
}

// --- API -----------------------------------------------------------------------------

export class MailApiError extends Error {
  constructor(
    public status: number,
    public code: string
  ) {
    super(code);
  }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(`/api/mail/${path}`, {
    ...rest,
    headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...pulseHeaders(), ...(rest.headers ?? {}) },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    credentials: "same-origin",
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) throw new MailApiError(res.status, (body as { error?: string } | null)?.error ?? "error");
  return body as T;
}

export const listKey = (l: ListRef): string => (l.q ? `q:${l.q}` : l.label ? `label:${l.label}` : `view:${l.view ?? "inbox"}`);

function listQuery(l: ListRef, offset = 0): string {
  const p = new URLSearchParams();
  if (l.q) p.set("q", l.q);
  else if (l.label) p.set("label", l.label);
  else p.set("view", l.view ?? "inbox");
  if (offset) p.set("offset", String(offset));
  return p.toString();
}

// --- Loading -------------------------------------------------------------------------

export async function loadBoot(): Promise<void> {
  try {
    const boot = await api<Boot>(`boot?ws=${encodeURIComponent(state.ws)}`);
    setState({ boot, bootError: null });
  } catch (e) {
    setState({ bootError: e instanceof MailApiError ? e.status : 0 });
  }
}

const inflight = new Map<string, Promise<void>>();

export function loadList(l: ListRef, opts: { more?: boolean } = {}): Promise<void> {
  const key = listKey(l);
  const cur = state.lists[key];
  const offset = opts.more && cur ? cur.threads.length : 0;
  const k = `${key}|${offset}`;
  const running = inflight.get(k);
  if (running) return running;
  setState((s) => ({ lists: { ...s.lists, [key]: { threads: cur?.threads ?? [], more: cur?.more ?? false, loading: true } } }));
  const p = api<{ threads: ThreadSummary[]; more: boolean }>(`threads?${listQuery(l, offset)}`)
    .then((r) => {
      setState((s) => {
        const prev = s.lists[key]?.threads ?? [];
        const threads = offset ? [...prev, ...r.threads.filter((t) => !prev.some((x) => x.id === t.id))] : r.threads;
        return { lists: { ...s.lists, [key]: { threads, more: r.more, loading: false } } };
      });
    })
    .catch((e) => {
      setState((s) => ({ lists: { ...s.lists, [key]: { threads: cur?.threads ?? [], more: false, loading: false, error: e instanceof MailApiError ? e.status : 0 } } }));
    })
    .finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

export async function loadThread(id: string): Promise<void> {
  try {
    const t = await api<MailThread>(`thread/${encodeURIComponent(id)}`);
    setState((s) => ({ threads: { ...s.threads, [id]: t } }));
  } catch (e) {
    if (e instanceof MailApiError && e.status === 404) setState((s) => ({ threads: { ...s.threads, [id]: null } }));
  }
}

export async function loadCounts(): Promise<void> {
  try {
    const r = await api<{ counts: Boot["counts"]; outbox: OutboxItem[]; accounts: MailAccount[] }>("counts");
    setState((s) => (s.boot ? { boot: { ...s.boot, counts: r.counts, outbox: r.outbox, accounts: r.accounts } } : {}));
  } catch {
    // The next poke tries again.
  }
}

/** Everything on screen again (a poke, a reconnect, after an action). */
export function refreshAll(): void {
  void loadCounts();
  const l = state.route.list;
  void loadList(l);
  if (state.route.thread) void loadThread(state.route.thread);
  // Lists seen before refresh when opened again.
  setState((s) => ({ lists: Object.fromEntries(Object.entries(s.lists).filter(([k]) => k === listKey(l))) }));
}

let timer: ReturnType<typeof setTimeout> | null = null;
function refreshSoon(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(refreshAll, 250);
}

/** Joins the workspace's pulse; without it, polls every 30 s. Returns a cleanup. */
export function startLive(ws: string): () => void {
  const p = pulse();
  const leave = p.join(ws);
  const offMail = p.on("mail", (m) => {
    refreshSoon();
    if (Number(m.data?.fresh) > 0) void loadBoot();
  });
  const offHello = p.on("hello", () => refreshSoon());
  const offStatus = p.onStatus((live) => setState({ live }));
  const poll = setInterval(() => {
    if (!p.live() && document.visibilityState === "visible") refreshAll();
  }, 30_000);
  return () => {
    offMail();
    offHello();
    offStatus();
    clearInterval(poll);
    leave();
  };
}

// --- Actions -------------------------------------------------------------------------

export type ActionName = "archive" | "inbox" | "trash" | "restore" | "spam" | "notspam" | "delete" | "read" | "unread" | "star" | "unstar" | "snooze" | "unsnooze" | "move" | "label" | "unlabel";

const INVERSE: Partial<Record<ActionName, ActionName>> = { archive: "inbox", inbox: "archive", trash: "restore", restore: "trash", spam: "notspam", notspam: "spam", read: "unread", unread: "read", star: "unstar", unstar: "star", snooze: "unsnooze", label: "unlabel", unlabel: "label" };
/** Actions after which a conversation leaves the list it was in. */
const LEAVES = new Set<ActionName>(["archive", "trash", "spam", "delete", "snooze", "move", "restore", "notspam", "inbox"]);

function patchThreads(ids: readonly string[], fn: (t: ThreadSummary) => ThreadSummary | null, onlyKey?: string): void {
  setState((s) => {
    const lists: Record<string, ListState> = {};
    for (const [k, l] of Object.entries(s.lists)) {
      if (onlyKey && k !== onlyKey) {
        lists[k] = l;
        continue;
      }
      lists[k] = { ...l, threads: l.threads.map((t) => (ids.includes(t.id) ? fn(t) : t)).filter((t): t is ThreadSummary => t !== null) };
    }
    return { lists };
  });
}

const DONE_TEXT: Partial<Record<ActionName, Parameters<typeof mt>[0]>> = {
  archive: "toast.archived",
  trash: "toast.trashed",
  spam: "toast.spammed",
  delete: "toast.deleted",
  snooze: "toast.snoozed",
  inbox: "toast.inboxed",
  restore: "toast.restored",
  notspam: "toast.notSpam",
  move: "toast.moved",
  label: "toast.labeled",
  unread: "toast.unread",
};

/**
 * Applies an action to conversations: the list changes now, the server
 * follows; "Undo" in the toast puts it back (⌘Z / Z while it is up).
 */
export async function act(action: ActionName, threadIds: string[], arg: { until?: number; label?: string } = {}, opts: { quiet?: boolean; undoable?: boolean } = {}): Promise<boolean> {
  if (!threadIds.length) return false;
  const key = listKey(state.route.list);
  const before = state.lists;
  if (LEAVES.has(action) && !(action === "inbox" && state.route.list.view === "inbox")) patchThreads(threadIds, () => null, key);
  else if (action === "read" || action === "unread") patchThreads(threadIds, (t) => ({ ...t, unread: action === "unread" }));
  else if (action === "star" || action === "unstar") patchThreads(threadIds, (t) => ({ ...t, starred: action === "star" }));
  else if (action === "label" || action === "unlabel") patchThreads(threadIds, (t) => ({ ...t, labels: action === "label" ? [...new Set([...t.labels, arg.label as string])] : t.labels.filter((l) => l !== arg.label) }));
  if (LEAVES.has(action)) {
    setState((s) => ({ selected: s.selected.filter((x) => !threadIds.includes(x)) }));
    if (state.route.thread && threadIds.includes(state.route.thread)) nextAfter(state.route.thread, key);
  }
  try {
    await api("actions", { method: "POST", json: { threads: threadIds, action, ...arg } });
  } catch (e) {
    setState({ lists: before });
    toast(e instanceof MailApiError && e.code.startsWith("no ") ? mt("err.noFolder") : mt("err.generic"), { kind: "error" });
    return false;
  }
  void loadCounts();
  if (state.route.thread && threadIds.includes(state.route.thread)) void loadThread(state.route.thread);
  const inverse = INVERSE[action];
  const text = DONE_TEXT[action];
  if (!opts.quiet && text) {
    toast(mt(text, { n: threadIds.length }), {
      ...(inverse && opts.undoable !== false
        ? {
            undo: async () => {
              await act(inverse, threadIds, arg, { quiet: true });
              refreshAll();
            },
          }
        : {}),
    });
  }
  return true;
}

/** After the open conversation leaves the list: the next one opens (Superhuman), else the list. */
function nextAfter(id: string, key: string): void {
  const list = state.lists[key]?.threads ?? [];
  const i = list.findIndex((t) => t.id === id);
  const next = list[i + 1] ?? list[i - 1];
  const full = state.boot?.prefs.pane === "full" || (typeof window !== "undefined" && window.innerWidth < 900);
  if (next && next.id !== id && !full) go({ ...state.route, thread: next.id }, true);
  else go({ list: state.route.list }, true);
}

// --- Routing -------------------------------------------------------------------------

export function routeFromUrl(pathname: string, search: string): Route {
  const parts = pathname.replace(/^\/mail\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const q = new URLSearchParams(search);
  const thread = q.get("t") ?? undefined;
  if (parts[0] === "settings") return { list: { view: "inbox" }, settings: true };
  if (parts[0] === "thread" && parts[1]) return { list: { view: "inbox" }, thread: parts[1] };
  if (parts[0] === "label" && parts[1]) return { list: { label: parts[1] }, thread };
  if (parts[0] === "search") return { list: { q: q.get("q") ?? "" }, thread };
  if (parts[0] === "view" && parts[1]) return { list: { view: parts[1] }, thread };
  return { list: { view: "inbox" }, thread };
}

export function urlOf(r: Route, ws: string): string {
  const q = new URLSearchParams();
  q.set("ws", ws);
  let path = "/mail";
  if (r.settings) path = "/mail/settings";
  else if (r.list.q !== undefined) {
    path = "/mail/search";
    q.set("q", r.list.q);
  } else if (r.list.label) path = `/mail/label/${encodeURIComponent(r.list.label)}`;
  else if (r.list.view && r.list.view !== "inbox") path = `/mail/view/${encodeURIComponent(r.list.view)}`;
  if (r.thread && !r.settings) q.set("t", r.thread);
  return `${path}?${q.toString()}`;
}

/** Client-side navigation (no reload; Back works). */
export function go(r: Route, replace = false): void {
  const url = urlOf(r, state.ws);
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  const sameList = listKey(r.list) === listKey(state.route.list);
  setState({ route: r, ...(sameList ? {} : { selected: [], focused: null }) });
  if (!r.settings) void loadList(r.list);
  if (r.thread) {
    void loadThread(r.thread);
    setState({ focused: r.thread });
  }
}

// --- Composers ---------------------------------------------------------------------

export function newDraftId(): string {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"[b & 63]).join("");
}

export function openComposer(c: Omit<ComposerState, "id"> & { id?: string }): string {
  const id = c.id ?? c.draft.id ?? newDraftId();
  setState((s) => {
    // A reply docks under its conversation: one at a time there.
    const others = s.composers.filter((x) => x.id !== id && !(c.inline && x.inline));
    return { composers: [...others.slice(-2), { ...c, id, draft: { ...c.draft, id } }] };
  });
  return id;
}

export function closeComposer(id: string): void {
  setState((s) => ({ composers: s.composers.filter((c) => c.id !== id) }));
}
