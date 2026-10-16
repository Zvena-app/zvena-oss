// Storage accounting and the per-account quota (default 2 GB).
//
// One quota per account covers everything the account pays for: documents
// and uploaded files of the workspaces it owns, and its Design teams. A
// member's upload into a shared workspace counts against that workspace's
// owner. Files are stored once per content; each owner's copy is counted.
// Guests (no account) get a random id in a cookie and may upload pictures
// only, within small per-guest, per-network and server-wide daily caps; their
// uploads are removed ZVENA_GUEST_FILE_TTL_DAYS after upload (or after that
// long without a visit), with a warning shown first. Signing in keeps them.

import { randomBytes } from "node:crypto";
import { config } from "./config";
import { NOTE_FILE_RE, removeNoteFiles } from "./notes/files";
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

/**
 * Notes a guest visit; returns when the guest's first files will be removed
 * (null: none stored). Visits do not extend a file's life past the TTL after
 * its upload: guest storage is a trial, not hosting.
 */
export function touchGuest(id: string): { removeAt: number | null; files: number } {
  const now = Date.now();
  sql("INSERT INTO guests (id, created_at, last_seen_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at, warned_at = NULL").run(id, now, now);
  const r = sql("SELECT COUNT(*) AS n, MIN(created_at) AS first FROM files WHERE owner_kind = 'guest' AND owner_id = ?").get(id) as { n: number; first: number | null };
  const files = Number(r.n);
  return { files, removeAt: files ? Number(r.first) + config.guestFileTtlDays * 86_400_000 : null };
}

/** Bytes a guest stores now. */
export function guestBytes(id: string): number {
  const r = sql("SELECT COALESCE(SUM(bytes), 0) AS b FROM files WHERE owner_kind = 'guest' AND owner_id = ?").get(id) as { b: number };
  return Number(r.b);
}

const DAY = 86_400_000;
const MB = 1024 * 1024;
// Guest bytes per network in the last day. In memory only (like the rate
// limiter, addresses never reach the disk); a restart forgets it, the
// server-wide cap in the database still holds.
const guestNets = new Map<string, { at: number; bytes: number }[]>();

/**
 * May a guest add `bytes` now? Checks the guest's own allowance, the
 * network's daily allowance (`network`: the limiter's client key, an IPv4
 * address or an IPv6 /64) and the server-wide daily cap.
 */
export function guestUploadAllowed(guest: string, network: string, bytes: number, now = Date.now()): { ok: true } | { ok: false; why: "guest" | "network" | "server" } {
  if (guestBytes(guest) + bytes > config.guestUploadMb * MB) return { ok: false, why: "guest" };
  const net = (guestNets.get(network) ?? []).filter((e) => now - e.at < DAY);
  if (net.reduce((a, e) => a + e.bytes, 0) + bytes > config.guestUploadMbPerIp * MB) return { ok: false, why: "network" };
  const all = sql("SELECT COALESCE(SUM(bytes), 0) AS b FROM guest_uploads WHERE at > ?").get(now - DAY) as { b: number };
  if (Number(all.b) + bytes > config.guestUploadMbPerDay * MB) return { ok: false, why: "server" };
  return { ok: true };
}

/** Counts a stored guest upload against the network's and the server's daily caps. */
export function noteGuestUpload(network: string, bytes: number, now = Date.now()): void {
  const key = network;
  const net = (guestNets.get(key) ?? []).filter((e) => now - e.at < DAY);
  net.push({ at: now, bytes });
  guestNets.set(key, net);
  if (guestNets.size > 5000) {
    for (const [k, v] of guestNets) if (!v.some((e) => now - e.at < DAY)) guestNets.delete(k);
  }
  sql("INSERT INTO guest_uploads (at, bytes) VALUES (?, ?)").run(now, bytes);
  sql("DELETE FROM guest_uploads WHERE at < ?").run(now - 2 * DAY);
}

// --- Moderation ------------------------------------------------------------------

const hashOf = (name: string) => name.slice(0, 40);

/** Was this file (by content) taken down by a moderator? */
export function isRemovedFile(name: string): boolean {
  return Boolean(sql("SELECT 1 FROM removed_files WHERE hash = ?").get(hashOf(name)));
}

/**
 * A moderator takes an uploaded file down: every stored copy (any extension,
 * any owner) is deleted from disk and from the accounting, and the content
 * is blocked from being uploaded or served again. Returns files removed.
 */
export async function removeFileByModerator(name: string, moderator: string | null): Promise<number> {
  if (!NOTE_FILE_RE.test(name)) return 0;
  const hash = hashOf(name);
  const names = new Set<string>([name]);
  tx(() => {
    for (const r of sql("SELECT DISTINCT name FROM files WHERE substr(name, 1, 40) = ?").all(hash) as { name: string }[]) names.add(r.name);
    sql("DELETE FROM files WHERE substr(name, 1, 40) = ?").run(hash);
    sql("INSERT INTO removed_files (hash, removed_at, removed_by) VALUES (?, ?, ?) ON CONFLICT(hash) DO NOTHING").run(hash, Date.now(), moderator);
  });
  return removeNoteFiles([...names]);
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
 * The cleanup job (scripts/cleanup.mjs, daily): removes guest uploads older
 * than the TTL and guests not seen for the TTL, then deletes files on disk
 * nobody stores any more. Returns what it did.
 */
export async function cleanupGuests(now = Date.now()): Promise<{ guests: number; files: number }> {
  const cutoff = now - config.guestFileTtlDays * 86_400_000;
  const stale = sql("SELECT id FROM guests WHERE last_seen_at < ?").all(cutoff) as { id: string }[];
  const names = new Set<string>();
  tx(() => {
    for (const r of sql("SELECT name FROM files WHERE owner_kind = 'guest' AND created_at < ?").all(cutoff) as { name: string }[]) names.add(r.name);
    sql("DELETE FROM files WHERE owner_kind = 'guest' AND created_at < ?").run(cutoff);
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
