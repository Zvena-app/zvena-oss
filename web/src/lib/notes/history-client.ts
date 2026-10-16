// Browser: the workspace's page history, updates and analytics
// (lib/notes/versions.ts on the server). Snapshots never change, so they
// are cached for the tab's life.

import type { Note } from "./types";

export interface VersionInfo {
  id: number;
  at: number;
  started: number;
  by: string | null;
  kind: "edit" | "delete" | "suggestion";
  /** An accepted suggestion (by = who suggested it): who accepted it. */
  acceptedBy?: string;
  title: string;
  bytes: number;
}

export interface UpdateEvent {
  at: number;
  by: string | null;
  kind: "create" | "move" | "trash" | "restore" | "delete";
  from?: string | null;
  to?: string | null;
}

export interface PageStats {
  views: number;
  viewers: number;
  days: number[];
  uniqueDays: number[];
  recentViewers: { id: string; name: string; at: number; views: number }[];
  editors: { id: string; name: string; at: number; versions: number }[];
}

const q = (ws: string, id: string) => `ws=${encodeURIComponent(ws)}&id=${encodeURIComponent(id)}`;

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "same-origin", cache: "no-store" });
  if (!r.ok) throw new Error(String(r.status));
  return (await r.json()) as T;
}

export function fetchVersions(ws: string, id: string): Promise<{ versions: VersionInfo[]; names: Record<string, string> }> {
  return getJson(`/api/notes/versions?${q(ws, id)}`);
}

const snapshots = new Map<string, Promise<Note>>();

/** One version as a note (cached; a failed load is tried again next time). */
export function fetchVersion(ws: string, id: string, v: number): Promise<Note> {
  const key = `${ws}:${id}:${v}`;
  let p = snapshots.get(key);
  if (!p) {
    p = getJson<{ note: Note }>(`/api/notes/versions?${q(ws, id)}&v=${v}`).then((r) => r.note);
    p.catch(() => snapshots.delete(key));
    snapshots.set(key, p);
  }
  return p;
}

export function fetchUpdates(ws: string, id: string): Promise<{ versions: VersionInfo[]; events: UpdateEvent[]; names: Record<string, string> }> {
  return getJson(`/api/notes/updates?${q(ws, id)}`);
}

export function fetchStats(ws: string, id: string): Promise<PageStats> {
  return getJson(`/api/notes/view?${q(ws, id)}&tz=${-new Date().getTimezoneOffset()}`);
}

const viewed = new Map<string, number>();

/** A member opened a page (the server counts one per 30 minutes; the tab does not ask more often either). */
export function recordView(ws: string, id: string): void {
  const key = `${ws}:${id}`;
  const now = Date.now();
  if (now - (viewed.get(key) ?? 0) < 30 * 60_000) return;
  viewed.set(key, now);
  void fetch(`/api/notes/view?ws=${encodeURIComponent(ws)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ noteId: id }),
    credentials: "same-origin",
  }).catch(() => viewed.delete(key));
}
