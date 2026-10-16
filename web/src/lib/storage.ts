// Storage accounting and the per-account quota (default 2 GB).
//
// One quota per account covers everything the account pays for: documents
// and uploaded files of the workspaces it owns, and its Design teams. A
// member's upload into a shared workspace counts against that workspace's
// owner. Files are stored once per content; each owner's copy is counted.
// Guests (no account) get a random id in a cookie; their uploads are removed
// after ZVENA_GUEST_FILE_TTL_DAYS without a visit, with a warning shown first.

import { randomBytes } from "node:crypto";
import { config } from "./config";
import { removeNoteFiles } from "./notes/files";
import { designUsage } from "./penpot";
import { sql, tx } from "./store";

export type Owner = { kind: "user" | "guest"; id: string };

export const GUEST_COOKIE = "zv_g";

/** Records that `owner` stores `name` (idempotent; refreshes last use). */
export function recordFile(owner: Owner, name: string, bytes: number): void {
  const now = Date.now();
  sql(
    "INSERT INTO files (name, owner_kind, owner_id, bytes, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(name, owner_kind, owner_id) DO UPDATE SET last_seen_at = excluded.last_seen_at"
  ).run(name, owner.kind, owner.id, bytes, now, now);
}

/** Bytes of documents and files an account pays for (Design excluded). */
export function docsUsage(userId: string): { notes: number; files: number } {
  const notes = sql("SELECT COALESCE(SUM(n.bytes), 0) AS b FROM notes n JOIN workspaces w ON w.id = n.ws WHERE w.owner_id = ? AND n.deleted = 0").get(userId) as { b: number };
  const files = sql("SELECT COALESCE(SUM(bytes), 0) AS b FROM files WHERE owner_kind = 'user' AND owner_id = ?").get(userId) as { b: number };
  return { notes: Number(notes.b), files: Number(files.b) };
}

const designCache = new Map<string, { at: number; bytes: number }>();

/** Design bytes (cached a few minutes; Design down = the last known value or 0). */
export async function designBytes(userId: string): Promise<number> {
  const c = designCache.get(userId);
  if (c && Date.now() - c.at < 5 * 60_000) return c.bytes;
  try {
    const bytes = await designUsage(userId);
    designCache.set(userId, { at: Date.now(), bytes });
    return bytes;
  } catch {
    return c?.bytes ?? 0;
  }
}

export interface Usage {
  notes: number;
  files: number;
  design: number;
  total: number;
  quota: number;
}

export async function usageOf(userId: string): Promise<Usage> {
  const d = docsUsage(userId);
  const design = await designBytes(userId);
  const total = d.notes + d.files + design;
  return { ...d, design, total, quota: config.storageQuota };
}

/** What the account may still add (0 when full; Infinity when the quota is off). */
export async function quotaLeft(userId: string): Promise<number> {
  if (config.storageQuota === 0) return Infinity;
  const u = await usageOf(userId);
  return Math.max(0, u.quota - u.total);
}

/** The workspace owner (who pays for what members add). */
export function payerOf(wsId: string): string | null {
  const r = sql("SELECT owner_id FROM workspaces WHERE id = ?").get(wsId) as { owner_id: string } | undefined;
  return r?.owner_id ?? null;
}

// --- Guests -------------------------------------------------------------------

export function newGuestId(): string {
  return randomBytes(16).toString("hex");
}

export function isGuestId(v: string | null | undefined): v is string {
  return typeof v === "string" && /^[0-9a-f]{32}$/.test(v);
}

/** Notes a guest visit; returns when the guest's files will be removed (null: none stored). */
export function touchGuest(id: string): { removeAt: number | null; files: number } {
  const now = Date.now();
  sql("INSERT INTO guests (id, created_at, last_seen_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at, warned_at = NULL").run(id, now, now);
  sql("UPDATE files SET last_seen_at = ? WHERE owner_kind = 'guest' AND owner_id = ?").run(now, id);
  const n = sql("SELECT COUNT(*) AS n FROM files WHERE owner_kind = 'guest' AND owner_id = ?").get(id) as { n: number };
  const files = Number(n.n);
  return { files, removeAt: files ? now + config.guestFileTtlDays * 86_400_000 : null };
}

/** On sign-in: the guest's uploads become the account's. */
export function adoptGuestFiles(guestId: string, userId: string): void {
  tx(() => {
    const rows = sql("SELECT name, bytes, created_at FROM files WHERE owner_kind = 'guest' AND owner_id = ?").all(guestId) as { name: string; bytes: number; created_at: number }[];
    for (const r of rows) {
      sql(
        "INSERT INTO files (name, owner_kind, owner_id, bytes, created_at, last_seen_at) VALUES (?, 'user', ?, ?, ?, ?) ON CONFLICT(name, owner_kind, owner_id) DO NOTHING"
      ).run(r.name, userId, r.bytes, r.created_at, Date.now());
    }
    sql("DELETE FROM files WHERE owner_kind = 'guest' AND owner_id = ?").run(guestId);
    sql("DELETE FROM guests WHERE id = ?").run(guestId);
  });
}

/**
 * The cleanup job (scripts/cleanup.mjs, daily): removes guest uploads not
 * used for the TTL, then deletes files on disk nobody stores any more.
 * Returns what it did.
 */
export async function cleanupGuests(now = Date.now()): Promise<{ guests: number; files: number }> {
  const cutoff = now - config.guestFileTtlDays * 86_400_000;
  const stale = sql("SELECT id FROM guests WHERE last_seen_at < ?").all(cutoff) as { id: string }[];
  const names = new Set<string>();
  tx(() => {
    for (const g of stale) {
      for (const r of sql("SELECT name FROM files WHERE owner_kind = 'guest' AND owner_id = ?").all(g.id) as { name: string }[]) names.add(r.name);
      sql("DELETE FROM files WHERE owner_kind = 'guest' AND owner_id = ?").run(g.id);
      sql("DELETE FROM guests WHERE id = ?").run(g.id);
    }
  });
  const orphans = [...names].filter((n) => !sql("SELECT 1 FROM files WHERE name = ? LIMIT 1").get(n));
  const removed = await removeNoteFiles(orphans);
  return { guests: stale.length, files: removed };
}

const FILE_REF_RE = /\/api\/notes\/file\/([a-f0-9]{40}\.[a-z0-9]{1,5})/g;

/**
 * Before a deleted account's files go: those that documents (or public
 * copies) of workspaces it no longer owns still show — a team workspace
 * handed to the next member, one given away earlier — are recorded for
 * those workspaces' owners, so they stay on disk. Returns how many.
 */
export function handOverFiles(userId: string, wsIds: readonly string[]): number {
  const mine = new Map((sql("SELECT name, bytes FROM files WHERE owner_kind = 'user' AND owner_id = ?").all(userId) as { name: string; bytes: number }[]).map((r) => [r.name, Number(r.bytes)]));
  if (mine.size === 0) return 0;
  let n = 0;
  for (const ws of new Set(wsIds)) {
    const owner = payerOf(ws);
    if (!owner || owner === userId) continue;
    const used = new Set<string>();
    const scan = (text: string | null) => {
      for (const m of (text ?? "").matchAll(FILE_REF_RE)) if (mine.has(m[1])) used.add(m[1]);
    };
    for (const r of sql("SELECT json FROM notes WHERE ws = ? AND deleted = 0").iterate(ws) as Iterable<{ json: string | null }>) scan(r.json);
    for (const r of sql("SELECT json FROM note_shares WHERE ws = ?").iterate(ws) as Iterable<{ json: string | null }>) scan(r.json);
    for (const r of sql("SELECT file FROM custom_emoji WHERE ws = ?").iterate(ws) as Iterable<{ file: string }>) scan(r.file);
    for (const name of used) recordFile({ kind: "user", id: owner }, name, mine.get(name) ?? 0);
    n += used.size;
  }
  return n;
}

/** Removes a user's file rows and the files nobody else stores (account deletion). */
export async function dropUserFiles(userId: string): Promise<number> {
  const names = (sql("SELECT name FROM files WHERE owner_kind = 'user' AND owner_id = ?").all(userId) as { name: string }[]).map((r) => r.name);
  sql("DELETE FROM files WHERE owner_kind = 'user' AND owner_id = ?").run(userId);
  const orphans = names.filter((n) => !sql("SELECT 1 FROM files WHERE name = ? LIMIT 1").get(n));
  return removeNoteFiles(orphans);
}
