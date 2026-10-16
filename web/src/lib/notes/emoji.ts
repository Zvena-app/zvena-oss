// zvena Documents (browser): the open workspace's custom emoji, loaded once
// per workspace (NotesApp) and read by the icon picker, the ":" emoji search
// and the inline emoji. The list lives off globalThis so every bundle sees one.

export const EMOJI_NAME_RE = /^[a-z0-9_-]{1,32}$/;
/** Custom emoji are images uploaded to Documents, never another site's. */
export const EMOJI_FILE_RE = /^\/api\/notes\/file\/[a-f0-9]{40}\.(png|jpg|gif|webp|avif|svg)$/;

/** "Party Parrot!" → "party-parrot". */
export function emojiName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^:+|:+$/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 32);
}

export interface WorkspaceEmoji {
  name: string;
  url: string;
  createdBy?: string | null;
}

type Listener = () => void;

interface Directory {
  ws: string | null;
  list: WorkspaceEmoji[];
  listeners: Set<Listener>;
}

const KEY = Symbol.for("zvena.notes.customEmoji");
const g = globalThis as unknown as Record<symbol, Directory | undefined>;
const dir: Directory = (g[KEY] ??= { ws: null, list: [], listeners: new Set() });

const EMPTY: WorkspaceEmoji[] = [];

export function customEmoji(): WorkspaceEmoji[] {
  return dir.list.length ? dir.list : EMPTY;
}

export function subscribeCustomEmoji(fn: Listener): () => void {
  dir.listeners.add(fn);
  return () => dir.listeners.delete(fn);
}

function set(ws: string | null, list: WorkspaceEmoji[]): void {
  dir.ws = ws;
  dir.list = [...list].sort((a, b) => a.name.localeCompare(b.name));
  dir.listeners.forEach((fn) => fn());
}

export function emojiWorkspace(): string | null {
  return dir.ws;
}

/** Loads a workspace's custom emoji (guests have none; offline keeps the last list). */
export async function loadCustomEmoji(ws: string | null): Promise<void> {
  if (!ws) return set(null, []);
  try {
    const r = await fetch(`/api/notes/emoji?ws=${encodeURIComponent(ws)}`, { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) return;
    const j = (await r.json()) as { emoji?: WorkspaceEmoji[] };
    set(ws, j.emoji ?? []);
  } catch {
    // Offline: the list already loaded stays.
  }
}

/** Adds an emoji (an uploaded image URL) under a name; returns the saved name or an error code. */
export async function addCustomEmoji(name: string, url: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const ws = dir.ws;
  if (!ws) return { ok: false, error: "guest" };
  try {
    const r = await fetch(`/api/notes/emoji?ws=${encodeURIComponent(ws)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ name, url }),
    });
    const j = (await r.json().catch(() => ({}))) as { emoji?: WorkspaceEmoji; error?: string };
    if (!r.ok || !j.emoji) return { ok: false, error: j.error ?? "failed" };
    set(ws, [...dir.list.filter((e) => e.name !== j.emoji?.name), j.emoji]);
    return { ok: true, name: j.emoji.name };
  } catch {
    return { ok: false, error: "offline" };
  }
}

export async function removeCustomEmoji(name: string): Promise<boolean> {
  const ws = dir.ws;
  if (!ws) return false;
  try {
    const r = await fetch(`/api/notes/emoji?ws=${encodeURIComponent(ws)}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ name }),
    });
    if (!r.ok) return false;
    set(ws, dir.list.filter((e) => e.name !== name));
    return true;
  } catch {
    return false;
  }
}

/** Names matching a ":" search ("par" → party-parrot, parrot…), best first. */
export function searchCustomEmoji(query: string, limit = 20): WorkspaceEmoji[] {
  const q = query.trim().toLowerCase().replace(/^:/, "");
  const list = customEmoji();
  if (!q) return list.slice(0, limit);
  return list
    .filter((e) => e.name.includes(q))
    .sort((a, b) => Number(!a.name.startsWith(q)) - Number(!b.name.startsWith(q)) || a.name.localeCompare(b.name))
    .slice(0, limit);
}
