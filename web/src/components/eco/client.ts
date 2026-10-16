"use client";

// The ecosystem in the browser: the API client, and live cards.
//
// A card (an issue, a page, a project, a frame) can show up in many places
// at once: a block in a document, a row in a "Related" panel, a search
// result. They all read one store per workspace, which loads cards in
// batches and refreshes exactly the ones the workspace's pulse says changed.
// Nothing here keeps its own copy of an object's state: change the issue
// anywhere and every card of it follows.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { pulse, pulseHeaders, type PulseMessage } from "@/lib/pulse/client";
import type { Card, InboxItem, Related, SearchResults } from "@/lib/eco/types";

export class EcoHttpError extends Error {
  constructor(
    public status: number,
    public code: string
  ) {
    super(code);
  }
}

async function call<T>(method: "GET" | "POST" | "DELETE", path: string, ws: string, opts: { query?: Record<string, string>; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const q = new URLSearchParams({ ws, ...(opts.query ?? {}) });
  const res = await fetch(`/api/eco/${path}?${q}`, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    signal: opts.signal,
    headers: { ...(opts.body !== undefined ? { "content-type": "application/json" } : {}), ...pulseHeaders() },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new EcoHttpError(res.status, (data as { error?: string } | null)?.error ?? "error");
  return data as T;
}

export const eco = {
  related: (ws: string, ref: string) => call<Related>("GET", "related", ws, { query: { ref } }),
  cards: (ws: string, refs: string[]) => call<{ cards: Card[] }>("POST", "cards", ws, { body: { refs } }),
  search: (ws: string, q: string, signal?: AbortSignal) => call<SearchResults>("GET", "search", ws, { query: { q }, signal }),
  link: (ws: string, src: string, dst: string) => call<{ ok: boolean }>("POST", "link", ws, { body: { src, dst } }),
  unlink: (ws: string, src: string, dst: string) => call<{ ok: boolean }>("DELETE", "link", ws, { query: { src, dst } }),
  issueFromDoc: (ws: string, body: { note: string; title: string; teamId?: string; assigneeId?: string; projectId?: string }) => call<{ card: Card }>("POST", "issue-from-doc", ws, { body }),
  issueDone: (ws: string, issue: string, done: boolean) => call<{ card: Card }>("POST", "issue-done", ws, { body: { issue, done } }),
  docForIssue: (ws: string, issue: string) => call<{ noteId: string; url: string }>("POST", "doc-for-issue", ws, { body: { issue } }),
  designForIssue: (ws: string, issue: string) => call<{ file: string; url: string }>("POST", "design-for-issue", ws, { body: { issue } }),
  docFor: (ws: string, ref: string) => call<{ noteId: string; url: string }>("POST", "doc-for", ws, { body: { ref } }),
  designFor: (ws: string, ref: string) => call<{ file: string; url: string }>("POST", "design-for", ws, { body: { ref } }),
  issues: (ws: string, q: { project?: string; mine?: boolean; done?: boolean }) =>
    call<{ cards: Card[] }>("GET", "issues", ws, { query: { ...(q.project ? { project: q.project } : {}), ...(q.mine ? { mine: "1" } : {}), ...(q.done ? { done: "1" } : {}) } }),
  projects: (ws: string) => call<{ projects: { id: string; name: string; icon: string | null; color: string }[] }>("GET", "projects", ws),
  inbox: (ws: string, archived = false) => call<{ items: InboxItem[]; unread: number }>("GET", "inbox", ws, { query: archived ? { archived: "1" } : {} }),
  unread: (ws: string) => call<{ unread: number }>("GET", "unread", ws),
  markInbox: (ws: string, ids: string[] | "all", action: "read" | "unread" | "archive" | "unarchive") => call<{ changed: number; unread: number }>("POST", "inbox", ws, { body: { ids, action } }),
};

/** Refreshes `load` when the pulse says this person's Inbox may have changed. */
function useInboxPulse(ws: string, me: string, load: () => void): void {
  useEffect(() => {
    if (!ws) return;
    const leave = pulse().join(ws);
    let t: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (t) clearTimeout(t);
      t = setTimeout(load, 250);
    };
    const offs = [
      pulse().on("inbox", (m) => (m.ref === me ? soon() : undefined)),
      // Projects' notifications follow its own changes (assigning, comments…).
      pulse().on("projects", (m) => (m.data?.entity === "issue" || m.data?.entity === "comment" || m.data?.entity === "project" ? soon() : undefined)),
      pulse().on("hello", soon),
    ];
    return () => {
      if (t) clearTimeout(t);
      offs.forEach((f) => f());
      leave();
    };
  }, [ws, me, load]);
}

/** The Inbox's unread count, live. */
export function useUnread(ws: string, me: string, initial = 0): number {
  const [n, setN] = useState(initial);
  const load = useCallback(() => {
    if (ws) eco.unread(ws).then((r) => setN(r.unread)).catch(() => undefined);
  }, [ws]);
  useInboxPulse(ws, me, load);
  return n;
}

/** The Inbox (or its archive), live. */
export function useInbox(ws: string, me: string, archived: boolean): { items: InboxItem[] | null; unread: number; reload: () => void; setItems: (fn: (items: InboxItem[]) => InboxItem[]) => void } {
  // Answers are kept with what they answer: switching to the archive shows "loading", not the Inbox.
  const key = `${ws}|${archived ? 1 : 0}`;
  const [state, setState] = useState<{ key: string; items: InboxItem[]; unread: number } | null>(null);
  const load = useCallback(() => {
    if (!ws) return;
    eco
      .inbox(ws, archived)
      .then((r) => setState({ key, items: r.items, unread: r.unread }))
      .catch(() => setState((s) => (s?.key === key ? s : { key, items: [], unread: 0 })));
  }, [ws, archived, key]);
  useEffect(() => {
    load();
  }, [load]);
  useInboxPulse(ws, me, load);
  const mine = state?.key === key ? state : null;
  return {
    items: mine?.items ?? null,
    unread: mine?.unread ?? 0,
    reload: load,
    setItems: (fn) => setState((s) => (s && s.key === key ? { ...s, items: fn(s.items) } : s)),
  };
}

/** "⌘" on Apple devices, "Ctrl" elsewhere (and while rendering on the server). */
/**
 * A live block in a document (an issue, a list of issues): pressing one of
 * its buttons or links must not select the block itself. ProseMirror would
 * keep the block selected after the next click into the text below (Chrome
 * reports no selection change there), and a selected block swallows the keys
 * typed next. Put on the block's root as onMouseDownCapture: ProseMirror
 * listens on the editor, which React's root-level handlers reach too late.
 */
export function keepTextSelection(e: { currentTarget: Element; target: EventTarget | null; preventDefault(): void }): void {
  const block = e.currentTarget;
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  // Fields of the block keep their own focus (the editor around it is contenteditable too).
  const field = t.closest("input, textarea, select, [contenteditable='true']");
  if (field && block.contains(field)) return;
  const press = t.closest("button, a[href], [role='button'], [role='option'], [role='menuitem']");
  if (press && block.contains(press)) e.preventDefault();
}

export function useModKey(): string {
  return useSyncExternalStore(
    noSubscribe,
    () => (/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"),
    () => "Ctrl"
  );
}
const noSubscribe = () => () => {};

// ------------------------------------------------------------ live cards

/** undefined: loading; null: not available (deleted, hidden, no access). */
export type CardState = Card | null | undefined;

class CardStore {
  private cache = new Map<string, Card | null>();
  private subs = new Map<string, Set<() => void>>();
  private want = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private leave: (() => void) | null = null;
  private offs: (() => void)[] = [];
  private users = 0;

  constructor(readonly ws: string) {}

  private attach(): void {
    if (this.leave) return;
    this.leave = pulse().join(this.ws);
    const p = pulse();
    this.offs = [p.on("*", (m) => this.onPulse(m)), p.on("hello", () => this.reload([...this.cache.keys()]))];
  }

  private detach(): void {
    this.offs.forEach((f) => f());
    this.offs = [];
    this.leave?.();
    this.leave = null;
  }

  private onPulse(m: PulseMessage): void {
    const ids = m.refs ?? (m.ref ? [m.ref] : []);
    const keys: string[] = [];
    if (m.type === "projects") {
      for (const id of ids) keys.push(`issue:${id}`, `project:${id}`);
      // An issue's change moves its project's progress.
      for (const k of this.cache.keys()) if (k.startsWith("project:")) keys.push(k);
    } else if (m.type === "notes") {
      for (const id of ids) keys.push(`note:${id}`);
    } else if (m.type === "design") {
      for (const id of ids) for (const k of this.cache.keys()) if (k === `design:${id}` || k.startsWith(`design:${id}/`)) keys.push(k);
    }
    this.reload(keys.filter((k) => this.cache.has(k)));
  }

  get(key: string): CardState {
    if (this.cache.has(key)) return this.cache.get(key);
    this.reload([key]);
    return undefined;
  }

  /** Cards just received from elsewhere (a "Related" answer, a search): no second request. */
  seed(cards: readonly Card[]): void {
    for (const c of cards) {
      this.cache.set(c.key, c);
      this.notify(c.key);
    }
  }

  reload(keys: readonly string[]): void {
    if (!keys.length) return;
    for (const k of keys) this.want.add(k);
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), 60);
  }

  private async flush(): Promise<void> {
    this.timer = null;
    const keys = [...this.want].slice(0, 200);
    keys.forEach((k) => this.want.delete(k));
    if (!keys.length) return;
    try {
      const { cards } = await eco.cards(this.ws, keys);
      const got = new Map(cards.map((c) => [c.key, c]));
      for (const k of keys) {
        this.cache.set(k, got.get(k) ?? null);
        this.notify(k);
      }
    } catch {
      // Offline or signed out: what is shown stays; the next poke or reconnect tries again.
      for (const k of keys) {
        if (this.cache.has(k)) continue;
        this.cache.set(k, null);
        this.notify(k);
      }
    }
    if (this.want.size && !this.timer) this.timer = setTimeout(() => void this.flush(), 60);
  }

  private notify(key: string): void {
    this.subs.get(key)?.forEach((fn) => fn());
  }

  subscribe(key: string, fn: () => void): () => void {
    if (this.users++ === 0) this.attach();
    let set = this.subs.get(key);
    if (!set) this.subs.set(key, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (--this.users === 0) this.detach();
    };
  }
}

const stores = new Map<string, CardStore>();

export function cardStore(ws: string): CardStore {
  let s = stores.get(ws);
  if (!s) stores.set(ws, (s = new CardStore(ws)));
  return s;
}

/** One live card. */
export function useCard(ws: string, key: string): CardState {
  const store = cardStore(ws);
  const subscribe = useCallback((fn: () => void) => store.subscribe(key, fn), [store, key]);
  const get = useCallback(() => (key ? store.get(key) : null), [store, key]);
  return useSyncExternalStore(subscribe, get, () => undefined);
}

// ------------------------------------------------------------ related

/** What an object is linked with; refreshed when the pulse says its links changed. */
export function useRelated(ws: string, ref: string): { data: Related | null; error: boolean; reload: () => void } {
  const [state, setState] = useState<{ ref: string; data: Related | null; error: boolean } | null>(null);
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!ws || !ref) return;
    const mine = ++seq.current;
    eco
      .related(ws, ref)
      .then((r) => {
        if (mine !== seq.current) return;
        cardStore(ws).seed(r.items.map((i) => i.card));
        setState({ ref, data: r, error: false });
      })
      .catch(() => mine === seq.current && setState((s) => ({ ref, data: s?.ref === ref ? s.data : null, error: true })));
  }, [ws, ref]);
  useEffect(() => {
    load();
    if (!ws || !ref) return;
    const leave = pulse().join(ws);
    let t: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (t) clearTimeout(t);
      t = setTimeout(load, 120);
    };
    const offLinks = pulse().on("links", (m) => (m.ref === ref || m.refs?.includes(ref) ? soon() : undefined));
    const offHello = pulse().on("hello", soon);
    return () => {
      if (t) clearTimeout(t);
      offLinks();
      offHello();
      leave();
    };
  }, [ws, ref, load]);
  const mine = state?.ref === ref ? state : null;
  const data = mine?.data ?? null;
  // Still being indexed: look again shortly.
  useEffect(() => {
    if (!data?.indexing) return;
    const t = setTimeout(load, 2500);
    return () => clearTimeout(t);
  }, [data, load]);
  return { data, error: mine?.error ?? false, reload: load };
}

// ------------------------------------------------------------ issue lists

/** A live list of issues (a project's, or mine): it reloads when Projects changes. */
export function useIssueList(ws: string, q: { project?: string; mine?: boolean; done?: boolean }): { cards: Card[] | null; reload: () => void } {
  const key = `${ws}|${q.project ?? ""}|${q.mine ? 1 : 0}|${q.done ? 1 : 0}`;
  const [state, setState] = useState<{ key: string; cards: Card[] } | null>(null);
  const { project, mine, done } = q;
  const load = useCallback(() => {
    if (!ws || (!project && !mine)) return;
    eco
      .issues(ws, { project, mine, done })
      .then((r) => {
        cardStore(ws).seed(r.cards);
        setState({ key, cards: r.cards });
      })
      .catch(() => setState((s) => (s?.key === key ? s : { key, cards: [] })));
  }, [ws, project, mine, done, key]);
  useEffect(() => {
    load();
    if (!ws) return;
    const leave = pulse().join(ws);
    let t: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (t) clearTimeout(t);
      t = setTimeout(load, 250);
    };
    const offs = [pulse().on("projects", (m) => (m.data?.entity === "issue" || m.data?.entity === "project" || !m.data ? soon() : undefined)), pulse().on("hello", soon)];
    return () => {
      if (t) clearTimeout(t);
      offs.forEach((f) => f());
      leave();
    };
  }, [ws, load]);
  return { cards: state?.key === key ? state.cards : null, reload: load };
}
