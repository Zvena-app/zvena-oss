// Server-only: what a person wants to hear about in Documents (Notion's
// "My notifications" and "Follow page"), and whether their page views are
// kept (Notion's "Page view history").
//
//  - Notification settings, per person: each kind of Inbox notification
//    Documents sends may be turned off (mentions, replies, comments on pages
//    they created, people they are assigned to, suggested edits, reminders,
//    updates of pages they follow). Invitations always arrive.
//  - Following a page: its edits (one unread notification per page, kept
//    fresh) and every new comment on it come to the Inbox.
//  - Page view history off: their visits are not recorded and they are left
//    out of a page's viewers.

import { sql } from "../store";

let ready = false;
function ensureTables(): void {
  if (ready) return;
  sql("CREATE TABLE IF NOT EXISTS note_user_prefs (user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key))").run();
  sql("CREATE TABLE IF NOT EXISTS note_follows (ws TEXT NOT NULL, note_id TEXT NOT NULL, user_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (ws, note_id, user_id))").run();
  sql("CREATE INDEX IF NOT EXISTS note_follows_user ON note_follows(user_id)").run();
  ready = true;
}

/** The kinds a person may turn off, and the Inbox kinds each covers. */
export const NOTIFY_SETTINGS = {
  mention: ["mention"],
  reply: ["reply"],
  comment: ["comment"],
  assigned: ["assigned"],
  suggestion: ["suggestion", "suggestion_accepted", "suggestion_rejected"],
  reminder: ["reminder"],
  follow: ["page_update"],
} as const;
export type NotifySetting = keyof typeof NOTIFY_SETTINGS;
const SETTINGS = Object.keys(NOTIFY_SETTINGS) as NotifySetting[];

export interface DocsPrefs {
  /** Notification kinds turned off. */
  muted: NotifySetting[];
  /** Page views are recorded and shown (Notion's "Page view history"). */
  viewHistory: boolean;
  /** Unread mentions, replies and comments also come by e-mail (Notion's e-mail notifications). */
  emailDigest: boolean;
}

function read(userId: string): Map<string, string> {
  ensureTables();
  return new Map((sql("SELECT key, value FROM note_user_prefs WHERE user_id = ?").all(userId) as { key: string; value: string }[]).map((r) => [r.key, r.value]));
}

export function docsPrefs(userId: string): DocsPrefs {
  const m = read(userId);
  return { muted: SETTINGS.filter((k) => m.get(`notify.${k}`) === "0"), viewHistory: m.get("views.history") !== "0", emailDigest: m.get("mail.digest") !== "0" };
}

/** Saves what the person sent (unknown keys ignored). */
export function setDocsPrefs(userId: string, patch: unknown): DocsPrefs {
  ensureTables();
  if (patch && typeof patch === "object" && !Array.isArray(patch)) {
    const p = patch as { notify?: unknown; viewHistory?: unknown; emailDigest?: unknown };
    const put = (key: string, on: boolean) =>
      sql("INSERT INTO note_user_prefs (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value").run(userId, key, on ? "1" : "0");
    if (p.notify && typeof p.notify === "object" && !Array.isArray(p.notify)) {
      for (const [k, v] of Object.entries(p.notify as Record<string, unknown>)) if ((SETTINGS as string[]).includes(k) && typeof v === "boolean") put(`notify.${k}`, v);
    }
    if (typeof p.viewHistory === "boolean") put("views.history", p.viewHistory);
    if (typeof p.emailDigest === "boolean") put("mail.digest", p.emailDigest);
  }
  return docsPrefs(userId);
}

/** Whether a person turned off this kind of Inbox notification (kinds outside Documents' settings never are). */
export function mutedKind(userId: string, kind: string): boolean {
  const setting = SETTINGS.find((s) => (NOTIFY_SETTINGS[s] as readonly string[]).includes(kind));
  if (!setting) return false;
  ensureTables();
  return (sql("SELECT value FROM note_user_prefs WHERE user_id = ? AND key = ?").get(userId, `notify.${setting}`) as { value: string } | undefined)?.value === "0";
}

/** Whether the person's page views are kept. */
export function keepsViews(userId: string): boolean {
  ensureTables();
  return (sql("SELECT value FROM note_user_prefs WHERE user_id = ? AND key = 'views.history'").get(userId) as { value: string } | undefined)?.value !== "0";
}

/** The person chose their time zone in Settings (their browsers stop reporting theirs). */
export function manualTimeZone(userId: string): boolean {
  ensureTables();
  return (sql("SELECT value FROM note_user_prefs WHERE user_id = ? AND key = 'tz.manual'").get(userId) as { value: string } | undefined)?.value === "1";
}

export function setManualTimeZone(userId: string, manual: boolean): void {
  ensureTables();
  sql("INSERT INTO note_user_prefs (user_id, key, value) VALUES (?, 'tz.manual', ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value").run(userId, manual ? "1" : "0");
}

/** People who turned their page view history off (of those given). */
export function hiddenViewers(ids: readonly string[]): Set<string> {
  ensureTables();
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    if (!part.length) continue;
    for (const r of sql(`SELECT user_id FROM note_user_prefs WHERE key = 'views.history' AND value = '0' AND user_id IN (${part.map(() => "?").join(",")})`).all(...part) as { user_id: string }[]) out.add(r.user_id);
  }
  return out;
}

// --- Following pages ------------------------------------------------------------

export function follows(ws: string, noteId: string, userId: string): boolean {
  ensureTables();
  return Boolean(sql("SELECT 1 FROM note_follows WHERE ws = ? AND note_id = ? AND user_id = ?").get(ws, noteId, userId));
}

export function setFollow(ws: string, noteId: string, userId: string, on: boolean, now = Date.now()): boolean {
  ensureTables();
  if (on) sql("INSERT INTO note_follows (ws, note_id, user_id, at) VALUES (?, ?, ?, ?) ON CONFLICT(ws, note_id, user_id) DO NOTHING").run(ws, noteId, userId, now);
  else sql("DELETE FROM note_follows WHERE ws = ? AND note_id = ? AND user_id = ?").run(ws, noteId, userId);
  return on;
}

/** Who follows a page. */
export function followersOf(ws: string, noteId: string): string[] {
  ensureTables();
  return (sql("SELECT user_id FROM note_follows WHERE ws = ? AND note_id = ? LIMIT 500").all(ws, noteId) as { user_id: string }[]).map((r) => r.user_id);
}

/** An account deleted: its settings and follows go with it. */
export function dropUserDocsPrefs(userId: string): void {
  ensureTables();
  sql("DELETE FROM note_user_prefs WHERE user_id = ?").run(userId);
  sql("DELETE FROM note_follows WHERE user_id = ?").run(userId);
}

/** A page deleted for good, or a workspace gone: nobody follows it any more. */
export function dropFollows(ws: string, noteId?: string): void {
  ensureTables();
  if (noteId) sql("DELETE FROM note_follows WHERE ws = ? AND note_id = ?").run(ws, noteId);
  else sql("DELETE FROM note_follows WHERE ws = ?").run(ws);
}
