// Server-only: Documents' e-mail notifications (Notion's). Someone who has
// not read a mention, a reply, a comment on their page or an assignment in
// the Inbox for a while gets one letter listing them (their pages, still
// open to them, in their language), at most one letter per half hour. Off in
// Settings → My notifications ("E-mail me about unread notifications").
// What people typed (titles, comments, names) reaches the letter without live
// links (calendar/defang.ts).

import { config } from "../config";
import { defang } from "../calendar/defang";
import { lettersLeave, sendMail } from "../mail";
import { sql } from "../store";
import { userLocale } from "../user-locale";
import { pageLevel } from "./access";
import { docsPrefs, mutedKind } from "./follows";
import { inTrash } from "./server-store";
import { notesT, type NotesKey } from "./i18n";

/** Unread for this long before a letter goes. */
export const DIGEST_DELAY = 15 * 60_000;
/** At most one letter per person in this time. */
export const DIGEST_GAP = 30 * 60_000;
/** Nothing older than this is mailed (a person back after a long time gets no flood). */
const MAX_AGE = 48 * 3_600_000;
const MAX_ITEMS = 20;
const KINDS = ["mention", "reply", "comment", "assigned", "invite"] as const;

let ready = false;
function ensure(): void {
  if (ready) return;
  sql("CREATE TABLE IF NOT EXISTS note_mail_digest (user_id TEXT PRIMARY KEY, last_at INTEGER NOT NULL DEFAULT 0, last_item INTEGER NOT NULL DEFAULT 0)").run();
  ready = true;
}

interface Item {
  id: string;
  ws_id: string;
  user_id: string;
  kind: (typeof KINDS)[number];
  ref: string;
  actor_id: string | null;
  text: string;
  created_at: number;
}

const LINE: Record<Item["kind"], NotesKey> = {
  mention: "digest.mention",
  reply: "digest.reply",
  comment: "digest.comment",
  assigned: "digest.assigned",
  invite: "digest.invite",
};

/** A letter that does not go within this long is left (the server's own mail never hangs a sweep). */
const SEND_TIMEOUT = 20_000;
let running = false;

/**
 * Takes this person's turn: true for exactly one sender (this process or
 * another), and only when their last letter was long enough ago.
 */
function claim(userId: string, now: number, newest: number): boolean {
  sql("INSERT OR IGNORE INTO note_mail_digest (user_id, last_at, last_item) VALUES (?, 0, 0)").run(userId);
  return Number(sql("UPDATE note_mail_digest SET last_at = ?, last_item = MAX(last_item, ?) WHERE user_id = ? AND last_at <= ?").run(now, newest, userId, now - DIGEST_GAP).changes) === 1;
}

/** Sends the letters due now; returns how many went. One sweep at a time. */
export async function sendDigests(now = Date.now()): Promise<number> {
  if (!lettersLeave() || running) return 0;
  running = true;
  try {
    return await sweep(now);
  } finally {
    running = false;
  }
}

async function sweep(now: number): Promise<number> {
  ensure();
  const rows = sql(
    `SELECT i.id, i.ws_id, i.user_id, i.kind, i.ref, i.actor_id, i.text, i.created_at
       FROM eco_inbox i
       LEFT JOIN note_mail_digest d ON d.user_id = i.user_id
      WHERE i.kind IN (${KINDS.map(() => "?").join(",")}) AND i.ref LIKE 'note:%'
        AND i.read_at IS NULL AND i.archived_at IS NULL
        AND i.created_at <= ? AND i.created_at > ? AND i.created_at > COALESCE(d.last_item, 0)
        AND COALESCE(d.last_at, 0) <= ?
      ORDER BY i.user_id, i.created_at`
  ).all(...KINDS, now - DIGEST_DELAY, now - MAX_AGE, now - DIGEST_GAP) as unknown as Item[];
  const byUser = new Map<string, Item[]>();
  for (const r of rows) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);
  let sent = 0;
  for (const [userId, items] of byUser) {
    const newest = Math.max(...items.map((i) => i.created_at));
    // Exactly one sender takes this person (a second sweep or process finds it taken), before anything is sent.
    if (!claim(userId, now, newest)) continue;
    const user = sql("SELECT email, name FROM users WHERE id = ?").get(userId) as { email: string | null; name: string } | undefined;
    if (!user?.email || !docsPrefs(userId).emailDigest) continue;
    const locale = userLocale(userId);
    const t = (k: NotesKey, v?: Record<string, string | number>) => notesT(locale, k, v);
    const lines: string[] = [];
    for (const it of items.slice(-MAX_ITEMS)) {
      const noteId = it.ref.slice(5);
      // Only pages the person can still open, not in the trash, of kinds they still want (checked now, not when it happened).
      if (mutedKind(userId, it.kind) || !pageLevel(userId, it.ws_id, noteId)) continue;
      const row = sql("SELECT json_extract(json, '$.title') AS title, json_extract(json, '$.parentId') AS parent, json_extract(json, '$.trashedAt') AS trashed FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(it.ws_id, noteId) as { title: string | null; parent: string | null; trashed: number | null } | undefined;
      if (!row || inTrash(it.ws_id, { parentId: row.parent ?? null, trashedAt: row.trashed ?? null })) continue;
      const title = row.title;
      const who = it.actor_id ? ((sql("SELECT name FROM users WHERE id = ?").get(it.actor_id) as { name: string } | undefined)?.name ?? "") : "";
      lines.push(`• ${t(LINE[it.kind], { name: defang(who) || "zvena", page: defang(title || "") || t("page.untitled") })}`);
      if (it.text) lines.push(`  “${defang(it.text).slice(0, 200)}”`);
      lines.push(`  ${config.appUrl}/docs?ws=${encodeURIComponent(it.ws_id)}#${noteId}`);
    }
    if (!lines.length) continue;
    const count = lines.filter((l) => l.startsWith("•")).length;
    const subject = t(count === 1 ? "digest.subjectOne" : "digest.subjectMany", { n: count });
    const text = [t("digest.lead"), "", ...lines, "", t("digest.footer", { url: `${config.appUrl}/docs?settings=1` })].join("\n");
    try {
      const timeout = new Promise<"failed">((done) => setTimeout(() => done("failed"), SEND_TIMEOUT).unref());
      if ((await Promise.race([sendMail({ to: user.email, subject, text }), timeout])) !== "failed") sent += 1;
    } catch {
      // A letter that cannot go is not retried (the Inbox still has them).
    }
  }
  return sent;
}

let started = false;
export function startMailDigests(): void {
  if (started) return;
  started = true;
  const tick = () => void sendDigests().catch((e) => console.error(`[notes] digest failed (${e instanceof Error ? e.name : "error"})`));
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 5 * 60_000).unref();
}
