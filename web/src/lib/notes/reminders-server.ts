// Server-only: reminders reach the Inbox (Notion notifies whoever set a
// reminder), also when none of their tabs is open. An after-push reaction
// records who set each reminder — the person whose push added it — and when
// it fires in their time zone; a minute ticker sends the due ones once.

import { notify } from "../eco/inbox";
import { sql, tx } from "../store";
import { onAfterPush, type NoteChange } from "./after-push";
import { collectReminders, type PendingReminder } from "./reminders";
import type { DbSchema, Note } from "./types";

const USER_RE = /^[A-Za-z0-9_-]{6,64}$/;
/** Missed by more than this (the server was down): dropped, as in the browser. */
const LATE = 12 * 3_600_000;

export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length > 64 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$|^UTC$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function setTimeZone(userId: string, tz: string, now = Date.now()): void {
  sql("INSERT INTO user_tz (user_id, tz, at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET tz = excluded.tz, at = excluded.at").run(userId, tz, now);
}

export function timeZoneOf(userId: string): string {
  const r = sql("SELECT tz FROM user_tz WHERE user_id = ?").get(userId) as { tz: string } | undefined;
  return r?.tz ?? (validTimeZone(process.env.ZVENA_TZ) ? (process.env.ZVENA_TZ as string) : "UTC");
}

function storedNote(ws: string, id: string): Note | null {
  const r = sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, id) as { json: string | null } | undefined;
  try {
    return (JSON.parse(r?.json ?? "null") as Note | null) ?? null;
  } catch {
    return null;
  }
}

function remindersOf(ws: string, note: Note | null, tz: string): PendingReminder[] {
  if (!note) return [];
  const schemas = new Map<string, DbSchema | undefined>();
  const schemaOf = (dbId: string) => {
    if (!schemas.has(dbId)) schemas.set(dbId, storedNote(ws, dbId)?.db);
    return schemas.get(dbId);
  };
  return collectReminders([note], schemaOf, tz);
}

/** Records the reminders a push added or removed (pure on its inputs; exported for tests). */
export function recordReminders(ws: string, changes: readonly NoteChange[], by: string): void {
  tx(() => {
    for (const c of changes) {
      if (!c.after) {
        sql("DELETE FROM note_reminders WHERE ws = ? AND note_id = ?").run(ws, c.id);
        continue;
      }
      const tz = USER_RE.test(by) ? timeZoneOf(by) : "UTC";
      const before = new Set(remindersOf(ws, c.before, tz).map((r) => r.key));
      const after = remindersOf(ws, c.after, tz);
      const keys = new Set(after.map((r) => r.key));
      for (const k of before) if (!keys.has(k)) sql("DELETE FROM note_reminders WHERE ws = ? AND rkey = ?").run(ws, k);
      // Only a person sets a reminder (forms and automations do not own one).
      if (!USER_RE.test(by)) continue;
      for (const r of after) {
        if (before.has(r.key)) continue;
        const text = (r.text || c.after.title || "").slice(0, 200);
        sql("INSERT INTO note_reminders (ws, rkey, note_id, user_id, at, text) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(ws, rkey, user_id) DO UPDATE SET at = excluded.at, text = excluded.text, sent_at = NULL").run(ws, r.key, c.id, by, r.at, text);
      }
    }
  });
}

onAfterPush("reminders", (changes, ctx) => recordReminders(ctx.ws, changes, ctx.by));

/** Whether a note or one of its ancestors is in the trash (only a trashed subtree's root carries trashedAt). */
function trashed(ws: string, note: Note): boolean {
  let cur: Note | null = note;
  for (let depth = 0; cur && depth < 100; depth++) {
    if (cur.trashedAt !== null) return true;
    cur = cur.parentId ? storedNote(ws, cur.parentId) : null;
  }
  return false;
}

/** Sends the reminders that are due; returns how many reached an Inbox. */
export function sendDueReminders(now = Date.now()): number {
  const due = sql("SELECT ws, rkey, note_id, user_id, at, text FROM note_reminders WHERE sent_at IS NULL AND at <= ? ORDER BY at LIMIT 500").all(now) as {
    ws: string;
    rkey: string;
    note_id: string;
    user_id: string;
    at: number;
    text: string;
  }[];
  let sent = 0;
  for (const r of due) {
    sql("UPDATE note_reminders SET sent_at = ? WHERE ws = ? AND rkey = ? AND user_id = ?").run(now, r.ws, r.rkey, r.user_id);
    if (now - r.at > LATE) continue;
    const note = storedNote(r.ws, r.note_id);
    if (!note || trashed(r.ws, note)) continue;
    notify(r.user_id, { ws: r.ws, kind: "reminder", ref: `note:${r.note_id}`, by: null, text: r.text || note.title });
    sent += 1;
  }
  // Sent long ago: nothing left to remember.
  sql("DELETE FROM note_reminders WHERE sent_at IS NOT NULL AND sent_at < ?").run(now - 30 * 86_400_000);
  return sent;
}

let ticking = false;

/** Once per process (instrumentation.ts): checks every minute. */
export function startReminderTicker(): void {
  if (ticking || process.env.ZVENA_MAINTENANCE === "off") return;
  ticking = true;
  setInterval(() => {
    try {
      sendDueReminders();
    } catch (e) {
      console.error(`[reminders] failed (${e instanceof Error ? e.name : "error"})`);
    }
  }, 60_000).unref();
}
