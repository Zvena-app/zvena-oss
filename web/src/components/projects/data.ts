"use client";

// The browser side of Projects' data: the API client, the bootstrap (teams,
// statuses, people… loaded once and refreshed when the workspace changes),
// a small query cache with optimistic patches, and toasts.
//
// Everything is fetched from and saved to the server; the cache only keeps
// what the open screens show. Other people's changes arrive through a cheap
// poll of the workspace's change counter (see ProjectsApp).

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { toast as dsToast, toasts } from "@/components/zvena/ds";
import type { Bootstrap, Cycle, CustomField, Issue, Label, Person, Project, SavedView, Status, Team } from "@/lib/projects/types";

// --- A tiny observable value ---------------------------------------------------

export class Store<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}
  get = (): T => this.value;
  set = (v: T): void => {
    this.value = v;
    for (const l of [...this.listeners]) l();
  };
  update = (fn: (v: T) => T): void => this.set(fn(this.value));
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  get size(): number {
    return this.listeners.size;
  }
}

export function useStore<T>(s: Store<T>): T {
  return useSyncExternalStore(s.subscribe, s.get, s.get);
}

// --- API client ----------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail?: string
  ) {
    super(code);
  }
}

let WS = "";
export function setWorkspace(id: string): void {
  WS = id;
}
export function workspaceId(): string {
  return WS;
}

export const online = new Store<boolean>(true);

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; query?: Record<string, string | number | undefined | null> | URLSearchParams; raw?: BodyInit; headers?: Record<string, string>; signal?: AbortSignal } = {}
): Promise<T> {
  const q = opts.query instanceof URLSearchParams ? new URLSearchParams(opts.query) : new URLSearchParams();
  if (!(opts.query instanceof URLSearchParams)) for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  q.set("ws", WS);
  let res: Response;
  try {
    res = await fetch(`/api/projects/${path}?${q}`, {
      method: opts.method ?? "GET",
      credentials: "same-origin",
      headers: opts.body !== undefined ? { "content-type": "application/json", ...opts.headers } : opts.headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : opts.raw,
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    online.set(false);
    throw new ApiError(0, "offline");
  }
  online.set(true);
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
    if (res.status === 401) window.location.replace(`/signin?next=${encodeURIComponent(location.pathname + location.search)}`);
    throw new ApiError(res.status, j.error ?? `http ${res.status}`, j.detail);
  }
  return (await res.json()) as T;
}

// --- Toasts: zvena's one toast (design system: UndoToast, rendered by the Shell's Toaster) ---

export interface ToastAction {
  label: string;
  run: () => void;
}

export function toast(text: string, kind: "info" | "error" | "success" = "info", action?: ToastAction, ms?: number): number {
  return dsToast(text, { kind, action, ms });
}

export function dismissToast(id: number): void {
  toasts().dismiss(id);
}

// --- Undo: changes happen at once; the toast (and Ctrl/Cmd+Z) takes them back ---

const UNDO_MS = 6000;

/** Says what was done, past tense, with Undo (the Toaster binds ⌘Z / Ctrl+Z while it is up). */
export function offerUndo(text: string, run: () => void): void {
  dsToast(text, { kind: "success", undo: run, ms: UNDO_MS });
}

// Deletions wait out the undo window, then go to the server; leaving the
// page sends the waiting ones at once (keepalive), so nothing is lost.
const pendingDeletes = new Map<number, { timer: ReturnType<typeof setTimeout>; ids: string[]; ws: string }>();
let deleteSeq = 0;

function sendDelete(ids: string[], ws: string, keepalive = false): Promise<Response> {
  return fetch(`/api/projects/issues/delete?ws=${encodeURIComponent(ws)}`, {
    method: "POST",
    credentials: "same-origin",
    keepalive,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    for (const [key, p] of pendingDeletes) {
      clearTimeout(p.timer);
      void sendDelete(p.ids, p.ws, true);
      pendingDeletes.delete(key);
    }
  });
}

export function deleteWithUndo(ids: string[], text: string, onError?: (e: unknown) => void): void {
  for (const id of ids) patchCachedIssue(id, null);
  const key = ++deleteSeq;
  const ws = WS;
  const timer = setTimeout(() => {
    pendingDeletes.delete(key);
    sendDelete(ids, ws)
      .then((r) => {
        if (!r.ok) throw new ApiError(r.status, "delete failed");
      })
      .catch((e) => onError?.(e))
      .finally(() => {
        invalidateAll();
        void loadBoot();
      });
  }, UNDO_MS);
  pendingDeletes.set(key, { timer, ids, ws });
  offerUndo(text, () => {
    clearTimeout(timer);
    pendingDeletes.delete(key);
    invalidateAll();
  });
}

// --- Bootstrap -----------------------------------------------------------------

export const boot = new Store<{ data: Bootstrap | null; error: ApiError | null; loading: boolean }>({ data: null, error: null, loading: true });

export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

let bootInflight: Promise<void> | null = null;
export function loadBoot(): Promise<void> {
  if (bootInflight) return bootInflight;
  bootInflight = api<Bootstrap>("bootstrap", { query: { today: localToday() } })
    .then((data) => boot.set({ data, error: null, loading: false }))
    .catch((e: ApiError) => boot.set({ data: boot.get().data, error: e, loading: false }))
    .finally(() => {
      bootInflight = null;
    });
  return bootInflight;
}

export interface Lookups {
  b: Bootstrap;
  team: Map<string, Team>;
  teamByKey: Map<string, Team>;
  status: Map<string, Status>;
  statusesOf: (teamId: string) => Status[];
  label: Map<string, Label>;
  person: Map<string, Person>;
  project: Map<string, Project>;
  cycle: Map<string, Cycle>;
  view: Map<string, SavedView>;
  field: Map<string, CustomField>;
  canEdit: boolean;
  canComment: boolean;
  isOwner: boolean;
  /** How far along a "started" status is (for its icon), 0..1. */
  fraction: (statusId: string) => number;
  currentCycle: (teamId: string) => Cycle | null;
  isFavorite: (kind: string, id: string) => boolean;
}

export function makeLookups(b: Bootstrap): Lookups {
  const status = new Map(b.statuses.map((s) => [s.id, s]));
  const byTeam = new Map<string, Status[]>();
  for (const s of b.statuses) byTeam.set(s.teamId, [...(byTeam.get(s.teamId) ?? []), s]);
  for (const l of byTeam.values()) l.sort((a, c) => a.position - c.position);
  const fav = new Set(b.favorites.map((f) => `${f.kind}:${f.targetId}`));
  return {
    b,
    team: new Map(b.teams.map((t) => [t.id, t])),
    teamByKey: new Map(b.teams.map((t) => [t.key, t])),
    status,
    statusesOf: (teamId) => byTeam.get(teamId) ?? [],
    label: new Map(b.labels.map((l) => [l.id, l])),
    person: new Map(b.people.map((p) => [p.id, p])),
    project: new Map(b.projects.map((p) => [p.id, p])),
    cycle: new Map(b.cycles.map((c) => [c.id, c])),
    view: new Map(b.views.map((v) => [v.id, v])),
    field: new Map(b.fields.map((f) => [f.id, f])),
    canEdit: b.ws.role === "owner" || b.ws.role === "editor",
    canComment: b.ws.role !== "viewer",
    isOwner: b.ws.role === "owner",
    fraction: (id) => {
      const s = status.get(id);
      if (!s || s.category !== "started") return 0;
      const started = (byTeam.get(s.teamId) ?? []).filter((x) => x.category === "started");
      const i = started.findIndex((x) => x.id === id);
      return Math.min(0.75, Math.max(0.25, (i + 1) / (started.length + 1)));
    },
    currentCycle: (teamId) => {
      const today = b.today;
      return b.cycles.find((c) => c.teamId === teamId && c.startsOn <= today && c.endsOn >= today && !c.completedAt) ?? null;
    },
    isFavorite: (kind, id) => fav.has(`${kind}:${id}`),
  };
}

export function useLookups(): Lookups {
  const { data } = useStore(boot);
  return useMemo(() => makeLookups(data as Bootstrap), [data]);
}

// --- Query cache ---------------------------------------------------------------

interface Entry {
  data?: unknown;
  error?: ApiError;
  loading: boolean;
  fetcher: () => Promise<unknown>;
  gen: number;
}

const cache = new Map<string, Store<Entry>>();
let generation = 0;

function entry(key: string, fetcher: () => Promise<unknown>): Store<Entry> {
  let s = cache.get(key);
  if (!s) {
    s = new Store<Entry>({ loading: true, fetcher, gen: -1 });
    cache.set(key, s);
  } else {
    s.get().fetcher = fetcher;
  }
  return s;
}

async function run(key: string, s: Store<Entry>): Promise<void> {
  const gen = generation;
  const cur = s.get();
  s.set({ ...cur, loading: true, gen });
  try {
    const data = await cur.fetcher();
    // A newer fetch of the same key may have finished first.
    if (s.get().gen === gen) s.set({ ...s.get(), data, error: undefined, loading: false });
  } catch (e) {
    if (s.get().gen === gen) s.set({ ...s.get(), error: e instanceof ApiError ? e : new ApiError(0, "error"), loading: false });
  }
}

/**
 * Every cached query counts as old: a screen that mounts shows its copy at once
 * and fetches it again (Projects opened again after a visit to another section).
 */
export function markStale(): void {
  generation++;
}

/** Refetches every query a screen is showing (others are dropped). */
export function invalidateAll(): void {
  generation++;
  for (const [key, s] of cache) {
    if (s.size > 0) void run(key, s);
    else cache.delete(key);
  }
}

export function invalidate(prefix: string): void {
  for (const [key, s] of cache) if (key.startsWith(prefix)) {
    if (s.size > 0) void run(key, s);
    else cache.delete(key);
  }
}

const EMPTY = new Store<Entry>({ loading: false, fetcher: async () => undefined, gen: 0 });

/**
 * A cached server query. `key` names it completely (the same key is the same
 * data); the fetcher is registered by the screen showing it, refetched when
 * stale and on invalidation while some screen shows it.
 */
export function useQuery<T>(key: string | null, fetcher: () => Promise<T>): { data: T | undefined; error: ApiError | undefined; loading: boolean; reload: () => void } {
  const s = key ? entry(key, fetcher) : EMPTY;
  const e = useStore(s);
  useEffect(() => {
    if (!key) return;
    const st = entry(key, fetcher);
    if (st.get().gen < generation) void run(key, st);
    // The key describes the query; a new fetcher closure for the same key fetches the same thing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const reload = useCallback(() => {
    if (key) void run(key, entry(key, fetcher));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { data: e.data as T | undefined, error: e.error, loading: e.loading && e.data === undefined, reload };
}

/** Applies a change to every cached copy of an issue (optimistic UI). */
function patchDeep(v: unknown, id: string, patch: Partial<Issue> | null): unknown {
  if (Array.isArray(v)) {
    let changed = false;
    const out: unknown[] = [];
    for (const x of v) {
      if (patch === null && x && typeof x === "object" && (x as { id?: string }).id === id && "identifier" in (x as object)) {
        changed = true;
        continue;
      }
      const y = patchDeep(x, id, patch);
      if (y !== x) changed = true;
      out.push(y);
    }
    return changed ? out : v;
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o.id === id && "identifier" in o && patch) return { ...o, ...patch };
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) {
      const y = patchDeep(x, id, patch);
      if (y !== x) changed = true;
      out[k] = y;
    }
    return changed ? out : v;
  }
  return v;
}

export function patchCachedIssue(id: string, patch: Partial<Issue> | null): void {
  for (const s of cache.values()) {
    const e = s.get();
    if (e.data === undefined) continue;
    const next = patchDeep(e.data, id, patch);
    if (next !== e.data) s.set({ ...e, data: next });
  }
}

/** Direct access for screens that rearrange their own data (board drag). */
export function setCached(key: string, fn: (v: unknown) => unknown): void {
  const s = cache.get(key);
  if (s && s.get().data !== undefined) s.set({ ...s.get(), data: fn(s.get().data) });
}

// --- Mutations -----------------------------------------------------------------

export function errorText(e: unknown, t: (k: "c.forbidden" | "c.offline" | "c.saveError", v?: Record<string, string>) => string): string {
  if (e instanceof ApiError) {
    if (e.status === 403) return t("c.forbidden");
    if (e.status === 0) return t("c.offline");
    return t("c.saveError", { msg: e.detail ?? e.code });
  }
  return t("c.saveError", { msg: String(e) });
}

/** A goal this person's change met: the last issue of a project or a milestone closed. */
export interface GoalReached {
  kind: "met" | "milestone";
  projectId: string;
  name: string;
  total: number;
}
export const GOALS_EVENT = "pj:goals";

function announceReached(goals: GoalReached[] | undefined): void {
  if (goals?.length) window.dispatchEvent(new CustomEvent<GoalReached[]>(GOALS_EVENT, { detail: goals }));
}

/** Saves an issue change: shown at once, confirmed by the server, rolled back on error. */
export async function saveIssue(id: string, patch: Record<string, unknown>, optimistic: Partial<Issue> = {}, onError?: (e: unknown) => void): Promise<Issue | null> {
  patchCachedIssue(id, optimistic);
  try {
    const { goals, ...it } = await api<Issue & { goals?: GoalReached[] }>(`issues/${id}`, { method: "PATCH", body: patch });
    announceReached(goals);
    patchCachedIssue(id, it);
    invalidateAll();
    void loadBoot();
    return it;
  } catch (e) {
    onError?.(e);
    invalidateAll();
    return null;
  }
}

export async function saveIssues(ids: string[], patch: Record<string, unknown>, optimistic: Partial<Issue> = {}, onError?: (e: unknown) => void): Promise<boolean> {
  for (const id of ids) patchCachedIssue(id, optimistic);
  try {
    const r = await api<{ goals?: GoalReached[] }>("issues/bulk", { method: "POST", body: { ids, patch } });
    announceReached(r.goals);
    invalidateAll();
    void loadBoot();
    return true;
  } catch (e) {
    onError?.(e);
    invalidateAll();
    return false;
  }
}

export async function toggleFavorite(kind: string, targetId: string, on: boolean): Promise<void> {
  await api("favorites", { method: "POST", body: { kind, targetId, on } });
  await loadBoot();
}
