// Server-only: what follows a write of Calendar, after it committed —
//   - the ecosystem's search row and links of each series (lib/eco/calendar.ts);
//   - a "calendar" poke (ids only) for whoever may see the calendar;
//   - guests: members hear it in their Inbox (notify, the one Inbox), people
//     invited by e-mail get the invitation (.ics, METHOD:REQUEST / CANCEL) with
//     a link to answer; at most so many letters per person per hour;
//   - CalDAV calendars: the series is marked to be sent to the server.

import { config } from "../config";
import { notify } from "../eco/inbox";
import { indexEvent } from "../eco/calendar";
import { sendMail } from "../mail";
import { emit } from "../pulse/bus";
import { sql } from "../store";
import { calRow } from "./access";
import { defang, knownMeetingUrl } from "./defang";
import { EVENT_ROWID_BASE } from "./db";
import { attendeesOf, eventRow, type AttRow, type EvRow, type GuestChange } from "./events";
import { seriesIcs } from "./export";
import { newToken, tokenHash } from "./seal";
import { calText } from "./strings";
import { intlOf } from "@/i18n/locales";

export interface AfterWrite {
  ws: string;
  by: string | null;
  origin?: string;
  seriesIds: readonly string[];
  calIds: readonly string[];
  guests?: GuestChange;
  moved?: boolean;
  deleted?: readonly string[];
  /** Send invitations and updates to guests (the editor's choice; default yes). */
  notifyGuests?: boolean;
  locale?: string;
  /** The change came from the CalDAV server itself (nothing to send back). */
  fromRemote?: boolean;
}

type CalDavPush = (calId: string) => void;
let davPush: CalDavPush | null = null;

/** CalDAV registers how it is told about local changes (lib/calendar/caldav.ts), without a cycle of imports. */
export function onCalDavChange(fn: CalDavPush): void {
  davPush = fn;
}

/** Series indexed on the write's own path; the rest (an import, a subscription, a sync) are indexed in the background. */
const INDEX_NOW = 25;
const INDEX_CHUNK = 100;
const queued = new Map<string, { ws: string; by: string | null }>();
let draining = false;

function indexOne(ws: string, id: string, by: string | null): void {
  try {
    indexEvent(ws, id, by);
  } catch (e) {
    console.error(`[calendar] index failed (${e instanceof Error ? e.name : "error"})`);
  }
}

function drain(): void {
  if (draining) return;
  draining = true;
  setImmediate(function step() {
    let n = 0;
    for (const [id, q] of queued) {
      queued.delete(id);
      indexOne(q.ws, id, q.by);
      if (++n >= INDEX_CHUNK) break;
    }
    if (queued.size) setImmediate(step);
    else draining = false;
  });
}

/** Re-indexes series in the background (a deleted calendar's events leave the shared index). */
export function queueIndex(ws: string, ids: readonly string[]): void {
  for (const id of ids) queued.set(id, { ws, by: null });
  if (queued.size) drain();
}

/** Indexes (now or soon) series whose search row is missing: what a restart cut short. Returns how many were found. */
export function sweepUnindexed(limit = 500): number {
  const rows = sql(
    `SELECT e.id, e.ws_id FROM cal_events e WHERE e.parent_id IS NULL AND e.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM eco_search s WHERE s.rowid = ${EVENT_ROWID_BASE} + e.seq) LIMIT ?`
  ).all(limit) as { id: string; ws_id: string }[];
  for (const r of rows) queued.set(r.id, { ws: r.ws_id, by: null });
  if (rows.length) drain();
  return rows.length;
}

export function afterWrite(w: AfterWrite): void {
  w.seriesIds.forEach((id, i) => {
    if (i < INDEX_NOW) indexOne(w.ws, id, w.by);
    else queued.set(id, { ws: w.ws, by: w.by });
  });
  if (queued.size) drain();
  for (const cal of new Set(w.calIds)) {
    emit(w.ws, { type: "calendar", ref: cal, refs: [...w.seriesIds], by: w.by ?? undefined, origin: w.origin });
    const c = calRow(cal);
    if (c?.kind === "caldav" && !w.fromRemote) {
      sql("UPDATE cal_events SET dirty = 1 WHERE cal_id = ? AND (id IN (SELECT value FROM json_each(?)) OR parent_id IN (SELECT value FROM json_each(?)))").run(cal, JSON.stringify(w.seriesIds), JSON.stringify(w.seriesIds));
      davPush?.(cal);
    }
  }
  if (w.notifyGuests === false) return;
  const series = w.seriesIds[0] ? eventRow(w.seriesIds[0]) : null;
  if (!series) return;
  const deleted = new Set(w.deleted ?? []);
  if (deleted.has(series.id)) {
    void tellGuests(series, attendeesOf(series.id), "cancel", w);
    return;
  }
  if (w.guests?.added.length) void tellGuests(series, w.guests.added, "invite", w);
  if (w.guests?.removed.length) void tellGuests(series, w.guests.removed, "cancel", w);
  if (w.moved) void tellGuests(series, w.guests?.kept ?? attendeesOf(series.id).filter((a) => !w.guests?.added.some((x) => x.email === a.email)), "update", w);
}

// ------------------------------------------------------------ letters

const PER_HOUR = 60;
const PER_DAY = 200;
let lettersTable = false;

/**
 * Whether this sender (a person, or a calendar) may send another letter to
 * someone outside zvena now — counted in the database, so a restart never
 * resets it (no one turns zvena into a mailer).
 */
export function mayMail(key: string, now = Date.now()): boolean {
  if (!lettersTable) {
    sql("CREATE TABLE IF NOT EXISTS cal_letters (sender TEXT NOT NULL, at INTEGER NOT NULL)").run();
    sql("CREATE INDEX IF NOT EXISTS cal_letters_sender ON cal_letters(sender, at)").run();
    lettersTable = true;
  }
  const count = (since: number) => Number((sql("SELECT COUNT(*) AS n FROM cal_letters WHERE sender = ? AND at > ?").get(key, since) as { n: number }).n);
  if (count(now - 3_600_000) >= PER_HOUR || count(now - 86_400_000) >= PER_DAY) return false;
  sql("INSERT INTO cal_letters (sender, at) VALUES (?, ?)").run(key, now);
  sql("DELETE FROM cal_letters WHERE at < ?").run(now - 2 * 86_400_000);
  return true;
}

/** "Thu, Oct 15, 10:00 AM – 10:30 AM (EDT)" in a language and zone. */
export function whenLine(r: Pick<EvRow, "all_day" | "start_at" | "end_at" | "start_day" | "end_day">, locale: string, tz: string): string {
  const tag = intlOf(locale);
  try {
    if (r.all_day === 1) {
      const d = (day: string) => {
        const [y, m, dd] = day.split("-").map(Number);
        return new Date(Date.UTC(y, m - 1, dd));
      };
      const f = new Intl.DateTimeFormat(tag, { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
      const last = new Date(d(r.end_day).getTime() - 86_400_000);
      return last.getTime() > d(r.start_day).getTime() ? f.formatRange(d(r.start_day), last) : f.format(d(r.start_day));
    }
    const f = new Intl.DateTimeFormat(tag, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz, timeZoneName: "short" });
    return f.formatRange(new Date(r.start_at), new Date(r.end_at));
  } catch {
    return new Date(r.start_at).toISOString();
  }
}

function organizerName(r: EvRow): string {
  return r.organizer_id ? ((sql("SELECT name FROM users WHERE id = ?").get(r.organizer_id) as { name: string } | undefined)?.name ?? "") : "";
}

/** Tells guests about an invitation, a change or a cancellation (members: Inbox; e-mail guests: a letter). */
async function tellGuests(r: EvRow, guests: readonly AttRow[], what: "invite" | "update" | "cancel", w: AfterWrite): Promise<void> {
  const locale = w.locale ?? "en";
  const title = r.title || calText(locale, "ev.untitled");
  const host = organizerName(r);
  for (const g of guests) {
    if (g.user_id) {
      if (what === "cancel") continue;
      notify(g.user_id, { ws: w.ws, kind: "invite", ref: `event:${r.id}`, by: w.by, text: what === "update" ? calText(locale, "inbox.updated", { title, when: whenLine(r, locale, r.tz) }) : title });
      continue;
    }
    if (g.email.startsWith("member:") || !mayMail(w.by ?? r.cal_id)) continue;
    // A fresh answer link with every letter (only its HMAC is kept).
    let answer = "";
    if (what !== "cancel") {
      const token = newToken(24);
      sql("UPDATE cal_attendees SET token_hash = ? WHERE event_id = ? AND email = ?").run(tokenHash("cal-rsvp", token), r.id, g.email);
      answer = `${config.appUrl}/cal/invite/${token}`;
    }
    const when = whenLine(r, locale, r.tz);
    // To someone outside zvena from zvena's sender: no one's words in the subject, and what they typed
    // (title, host, place) without live links; a call link only for known meeting hosts — the rest is in the .ics.
    const safeTitle = defang(title) || calText(locale, "ev.untitled");
    const subject = calText(locale, what === "invite" ? "mail.guestInviteSubject" : what === "update" ? "mail.guestUpdateSubject" : "mail.guestCancelSubject", { when });
    const lines = [
      what === "invite" ? calText(locale, "mail.inviteBody", { name: defang(host) || "zvena", title: safeTitle }) : what === "update" ? calText(locale, "mail.updateBody", { title: safeTitle }) : calText(locale, "mail.cancelBody", { title: safeTitle }),
      "",
      calText(locale, "mail.when", { when }),
      ...(r.location ? [calText(locale, "mail.where", { where: defang(r.location) })] : []),
      ...(r.conference && what !== "cancel" && knownMeetingUrl(r.conference) ? [calText(locale, "mail.join", { url: r.conference })] : []),
      ...(answer ? ["", calText(locale, "mail.answer", { url: answer })] : []),
      "",
      calText(locale, "mail.footer"),
    ];
    const ics = seriesIcs(r.id, { method: what === "cancel" ? "CANCEL" : "REQUEST", includeDeleted: what === "cancel" });
    try {
      await sendMail({ to: g.email, subject, text: lines.join("\n"), attachments: [{ filename: "invite.ics", content: ics, contentType: `text/calendar; charset=utf-8; method=${what === "cancel" ? "CANCEL" : "REQUEST"}` }] });
    } catch {
      // A letter that cannot go never undoes the change.
    }
  }
}
