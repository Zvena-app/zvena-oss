// Server-only: scheduling links (Notion Calendar's "Share availability").
//
// A host sets weekly hours, a meeting length, buffers, a minimum notice and
// how far ahead people may book; /cal/<slug> shows the free times, signed
// out. Nothing private leaks: the page gets the host's name, the link's own
// words and bare start times — never what the host is busy with.
//
// A booking checks the time again inside one transaction, makes the event in
// the host's calendar (the guest as an accepted attendee), tells the host in
// their Inbox, and e-mails both sides the invitation (.ics). The guest gets a
// private link to reschedule or cancel (its HMAC is kept, never the token).
//
// Abuse: the routes limit requests per address; here at most a few open
// bookings per e-mail per link and per day across zvena, a cap per link per
// day, and nothing the visitor typed is ever sent to the visitor's address
// (the letter to the guest holds only the host's words), so the form cannot
// mail strangers on someone's behalf.

import { config } from "../config";
import { notify } from "../eco/inbox";
import { sendMail } from "../mail";
import { newId, sql, tx } from "../store";
import { CalAccess, calRow, type CalRow } from "./access";
import { ensureDefault, localeOf, prefsOf } from "./calendars";
import { calDb } from "./db";
import { afterWrite, whenLine } from "./effects";
import { blankRow, CalError, eventRow, listRange, parseJson, putRow, type EvRow } from "./events";
import { seriesIcs } from "./export";
import { cleanWeekly, DEFAULT_WEEKLY, freeSlots, type Availability, type Busy } from "./slots";
import { newToken, tokenHash } from "./seal";
import { calText } from "./strings";
import { atMinute, dayOf, validTimeZone } from "./tz";
import { COLOR_RE, type LinkInfo } from "./types";
import { publishingAllowed } from "../enterprise/security";
import { defang, knownMeetingUrl } from "./defang";

export { defang, knownMeetingUrl };

export interface LinkRow {
  id: string;
  ws_id: string;
  user_id: string;
  slug: string;
  title: string;
  description: string;
  duration: number;
  step: number;
  buffer_before: number;
  buffer_after: number;
  notice_min: number;
  window_days: number;
  max_per_day: number;
  weekly: string;
  tz: string;
  cal_id: string;
  check_cals: string;
  location: string;
  conference: string;
  color: string;
  active: number;
  created_at: number;
  updated_at: number;
}

interface BookingRow {
  id: string;
  link_id: string;
  event_id: string | null;
  name: string;
  email: string;
  note: string;
  start_at: number;
  end_at: number;
  tz: string;
  locale: string;
  token_hash: string;
  status: "booked" | "canceled";
  created_at: number;
  updated_at: number;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;
/** Paths of /cal/ that are not links. */
const RESERVED = new Set(["invite", "manage", "api", "new", "admin", "help"]);
const EMAIL_RE = /^[^\s@<>"(),;:]{1,64}@[^\s@<>"(),;:]{1,190}\.[^\s@<>"(),;:]{2,63}$/;

export const bookingUrl = (slug: string) => `${config.appUrl}/cal/${slug}`;
const manageUrl = (slug: string, token: string) => `${config.appUrl}/cal/${slug}/${token}`;

function upcomingCount(linkId: string, now: number): number {
  return Number((sql("SELECT COUNT(*) AS n FROM cal_bookings WHERE link_id = ? AND status = 'booked' AND start_at > ?").get(linkId, now) as { n: number }).n);
}

export function linkInfo(r: LinkRow, now = Date.now()): LinkInfo {
  return {
    id: r.id,
    slug: r.slug,
    url: bookingUrl(r.slug),
    title: r.title,
    description: r.description,
    duration: r.duration,
    step: r.step,
    bufferBefore: r.buffer_before,
    bufferAfter: r.buffer_after,
    noticeMin: r.notice_min,
    windowDays: r.window_days,
    maxPerDay: r.max_per_day,
    weekly: parseJson(r.weekly, DEFAULT_WEEKLY),
    tz: r.tz,
    calId: r.cal_id,
    checkCals: parseJson<string[]>(r.check_cals, []),
    location: r.location,
    conference: r.conference,
    color: r.color,
    active: r.active === 1,
    bookings: upcomingCount(r.id, now),
  };
}

export function listLinks(acc: CalAccess): LinkInfo[] {
  calDb();
  if (!acc.member) return [];
  return (sql("SELECT * FROM cal_links WHERE ws_id = ? AND user_id = ? ORDER BY created_at").all(acc.ws, acc.userId) as unknown as LinkRow[]).map((r) => linkInfo(r));
}

function int(v: unknown, min: number, max: number, def: number): number {
  if (v === undefined) return def;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) throw new CalError(400, "bad number");
  return n;
}

function freshSlug(base: string): string {
  const stem = base
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30) || "meet";
  for (let i = 0; i < 20; i++) {
    const slug = `${stem}-${newId(3).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
    if (!sql("SELECT 1 FROM cal_links WHERE slug = ?").get(slug)) return slug;
  }
  return `meet-${newId(8).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
}

export interface LinkInput {
  title?: unknown;
  description?: unknown;
  slug?: unknown;
  duration?: unknown;
  step?: unknown;
  bufferBefore?: unknown;
  bufferAfter?: unknown;
  noticeMin?: unknown;
  windowDays?: unknown;
  maxPerDay?: unknown;
  weekly?: unknown;
  tz?: unknown;
  calId?: unknown;
  checkCals?: unknown;
  location?: unknown;
  conference?: unknown;
  color?: unknown;
  active?: unknown;
}

/** Creates (id null) or changes one of the person's links. */
export function saveLink(acc: CalAccess, id: string | null, input: LinkInput, hostName: string, now = Date.now()): LinkInfo {
  calDb();
  if (!acc.member) throw new CalError(403, "forbidden");
  const cur = id ? (sql("SELECT * FROM cal_links WHERE id = ? AND ws_id = ? AND user_id = ?").get(id, acc.ws, acc.userId) as LinkRow | undefined) : undefined;
  if (id && !cur) throw new CalError(404, "link not found");
  if (!cur && Number((sql("SELECT COUNT(*) AS n FROM cal_links WHERE user_id = ?").get(acc.userId) as { n: number }).n) >= 50) throw new CalError(429, "too many links");
  const prefs = prefsOf(acc.userId);
  const text = (v: unknown, max: number, def: string) => (v === undefined ? def : typeof v === "string" ? v.replace(/\u0000/g, "").trim().slice(0, max) : (() => { throw new CalError(400, "bad text"); })());
  const title = text(input.title, 120, cur?.title ?? calText(localeOf(acc.userId), "link.defaultTitle", { name: hostName }));
  if (!title) throw new CalError(400, "title required");
  const duration = int(input.duration, 5, 480, cur?.duration ?? 30);
  const step = int(input.step, 5, 240, cur?.step ?? Math.min(duration, 30));
  const weekly = input.weekly !== undefined ? cleanWeekly(input.weekly) : parseJson(cur?.weekly, DEFAULT_WEEKLY);
  if (!weekly) throw new CalError(400, "bad hours");
  const tz = input.tz !== undefined ? (validTimeZone(input.tz) ? input.tz : null) : (cur?.tz ?? prefs.tz);
  if (!tz) throw new CalError(400, "bad tz");
  // Bookings go into a calendar of one's own that one may write (made now if the person never opened Calendar here).
  ensureDefault(acc, hostName, prefs.tz, now);
  const own = (sql("SELECT * FROM cal_calendars WHERE ws_id = ? AND owner_id = ? AND deleted_at IS NULL").all(acc.ws, acc.userId) as unknown as CalRow[]);
  const calId = input.calId !== undefined ? input.calId : (cur?.cal_id ?? own.find((c) => c.is_default === 1)?.id);
  const into = own.find((c) => c.id === calId && c.kind !== "ics");
  if (!into) throw new CalError(400, "bad calendar");
  const check = input.checkCals !== undefined ? (Array.isArray(input.checkCals) ? (input.checkCals as unknown[]).filter((x): x is string => typeof x === "string" && own.some((c) => c.id === x)).slice(0, 50) : null) : parseJson<string[]>(cur?.check_cals, []);
  if (!check) throw new CalError(400, "bad calendars");
  const conference = text(input.conference, 2000, cur?.conference ?? "");
  if (conference && !/^https:\/\/[^\s<>"']+$/i.test(conference)) throw new CalError(400, "bad conference");
  const color = input.color !== undefined ? (typeof input.color === "string" && COLOR_RE.test(input.color) ? input.color : "") : (cur?.color ?? "");
  let slug = cur?.slug ?? "";
  if (input.slug !== undefined && input.slug !== slug) {
    const s = typeof input.slug === "string" ? input.slug.trim().toLowerCase() : "";
    if (!SLUG_RE.test(s) || RESERVED.has(s)) throw new CalError(400, "bad slug");
    if (sql("SELECT 1 FROM cal_links WHERE slug = ? AND id != ?").get(s, cur?.id ?? "")) throw new CalError(409, "slug taken");
    slug = s;
  }
  if (!slug) slug = freshSlug(hostName || title);
  const row: LinkRow = {
    id: cur?.id ?? newId(12),
    ws_id: acc.ws,
    user_id: acc.userId,
    slug,
    title,
    description: text(input.description, 2000, cur?.description ?? ""),
    duration,
    step,
    buffer_before: int(input.bufferBefore, 0, 240, cur?.buffer_before ?? 0),
    buffer_after: int(input.bufferAfter, 0, 240, cur?.buffer_after ?? 0),
    notice_min: int(input.noticeMin, 0, 43_200, cur?.notice_min ?? 240),
    window_days: int(input.windowDays, 1, 365, cur?.window_days ?? 30),
    max_per_day: int(input.maxPerDay, 0, 50, cur?.max_per_day ?? 0),
    weekly: JSON.stringify(weekly),
    tz,
    cal_id: into.id,
    check_cals: JSON.stringify(check),
    location: text(input.location, 500, cur?.location ?? ""),
    conference,
    color,
    active: input.active !== undefined ? (input.active === false ? 0 : 1) : (cur?.active ?? 1),
    created_at: cur?.created_at ?? now,
    updated_at: now,
  };
  const cols = Object.keys(row) as (keyof LinkRow)[];
  sql(`INSERT INTO cal_links (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`).join(", ")}`).run(...cols.map((c) => row[c]));
  return linkInfo(row, now);
}

export function deleteLink(acc: CalAccess, id: string): void {
  calDb();
  const n = sql("DELETE FROM cal_links WHERE id = ? AND ws_id = ? AND user_id = ?").run(id, acc.ws, acc.userId).changes;
  if (!Number(n)) throw new CalError(404, "link not found");
}

// ------------------------------------------------------------ the public side

export interface PublicLink {
  row: LinkRow;
  hostName: string;
}

/** Bookings a day: per link, and per host across their links. */
const LINK_DAILY_CAP = 30;
const HOST_DAILY_CAP = 60;

/** A link anyone may book: on, its host still a member, its calendar still theirs to write, publishing allowed. */
export function publicLink(slug: unknown): PublicLink | null {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) return null;
  calDb();
  const row = sql("SELECT * FROM cal_links WHERE slug = ? AND active = 1").get(slug) as LinkRow | undefined;
  if (!row) return null;
  const acc = new CalAccess(row.user_id, row.ws_id);
  if (!acc.member || !acc.canWrite(calRow(row.cal_id))) return null;
  // Settings → Security → publishing off: no page of the workspace answers the public.
  if (!publishingAllowed(row.ws_id)) return null;
  const host = sql("SELECT name, blocked_at FROM users WHERE id = ?").get(row.user_id) as { name: string; blocked_at: number | null } | undefined;
  if (!host || host.blocked_at) return null;
  return { row, hostName: host.name };
}

function availabilityOf(r: LinkRow): Availability {
  return { tz: r.tz, weekly: parseJson(r.weekly, DEFAULT_WEEKLY), duration: r.duration, step: r.step, bufferBefore: r.buffer_before, bufferAfter: r.buffer_after, noticeMin: r.notice_min, windowDays: r.window_days, maxPerDay: r.max_per_day };
}

/**
 * The host's busy times: their own calendars (the ones the link checks, or
 * all of them), and invitations they have not declined. Events shown as free
 * never block; an all-day event shown as busy (out of office) blocks its
 * days on the host's clock. All-day events are free unless set busy.
 */
export function hostBusy(r: LinkRow, from: number, to: number, exceptEvent?: string | null): Busy[] {
  const acc = new CalAccess(r.user_id, r.ws_id);
  const own = new Set((sql("SELECT id FROM cal_calendars WHERE ws_id = ? AND owner_id = ? AND deleted_at IS NULL").all(r.ws_id, r.user_id) as { id: string }[]).map((x) => x.id));
  const checks = parseJson<string[]>(r.check_cals, []).filter((c) => own.has(c));
  const cals = new Set(checks.length ? [...checks, r.cal_id] : own);
  return listRange({ acc, tz: r.tz }, { from, to })
    .filter((e) => e.busy && e.id !== exceptEvent && (cals.has(e.calId) || (e.invited && e.rsvp !== "declined")))
    .map((e) => (e.allDay ? { start: atMinute(e.startDay, 0, r.tz), end: atMinute(e.endDay, 0, r.tz) } : { start: e.start, end: e.end }));
}

function perDay(r: LinkRow, now: number, exceptBooking?: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of sql("SELECT id, start_at FROM cal_bookings WHERE link_id = ? AND status = 'booked' AND start_at > ?").all(r.id, now - 86_400_000) as { id: string; start_at: number }[]) {
    if (b.id === exceptBooking) continue;
    const d = dayOf(b.start_at, r.tz);
    out.set(d, (out.get(d) ?? 0) + 1);
  }
  return out;
}

/** Free starts in [from, to). */
export function slotsOf(r: LinkRow, from: number, to: number, now = Date.now(), except?: { event?: string | null; booking?: string }): number[] {
  const span = Math.min(Math.max(0, to - from), 62 * 86_400_000);
  const end = from + span;
  return freeSlots({ avail: availabilityOf(r), busy: hostBusy(r, from - 86_400_000, end + 86_400_000, except?.event), bookedPerDay: perDay(r, now, except?.booking), from, to: end, now });
}

export interface BookInput {
  start?: unknown;
  name?: unknown;
  email?: unknown;
  note?: unknown;
  tz?: unknown;
  locale?: unknown;
}

const inert = (s: string) => s.replace(/[\\[\]()<>!*_`#|~@]/g, (c) => `\\${c}`);

function hostMail(r: LinkRow): { email: string | null; locale: string } {
  const u = sql("SELECT email FROM users WHERE id = ?").get(r.user_id) as { email: string | null } | undefined;
  return { email: u?.email ?? null, locale: localeOf(r.user_id) };
}

function bookingEvent(link: PublicLink, b: { name: string; email: string; note: string; start: number; end: number; bookingId: string }, now: number): Omit<EvRow, "seq"> {
  const cal = calRow(link.row.cal_id) as CalRow;
  const base = blankRow(cal, link.row.user_id, now);
  const reminders = prefsOf(link.row.user_id).defaultReminders;
  return {
    ...base,
    title: `${link.row.title} · ${b.name}`.slice(0, 500),
    description: b.note ? inert(b.note) : "",
    location: link.row.location,
    conference: link.row.conference,
    color: link.row.color || null,
    all_day: 0,
    start_at: b.start,
    end_at: b.end,
    start_day: dayOf(b.start, link.row.tz),
    end_day: dayOf(b.end, link.row.tz),
    tz: link.row.tz,
    reminders: JSON.stringify(reminders),
    remind_lead: reminders.length ? Math.max(...reminders.map((x) => x.min)) + 1 : 0,
    booking_id: b.bookingId,
  };
}

async function letters(link: PublicLink, b: { name: string; email: string; note: string; locale: string; tz: string }, ev: EvRow, kind: "booked" | "canceled" | "moved", token: string | null): Promise<void> {
  const r = link.row;
  const guestWhen = whenLine(ev, b.locale, b.tz);
  const method = kind === "canceled" ? "CANCEL" : "REQUEST";
  const icsFile = (outsider: boolean) => [{ filename: "invite.ics", content: seriesIcs(ev.id, { method, includeDeleted: kind === "canceled", outsider }), contentType: `text/calendar; charset=utf-8; method=${method}` }];
  const L = (k: Parameters<typeof calText>[1], v?: Record<string, string | number>) => calText(b.locale, k, v);
  // To the guest — whatever address the visitor typed: the letter carries none
  // of the visitor's text, and the host's own words only defanged (no live
  // links, nothing in the subject), so a booking form cannot relay someone's
  // text to any address. Its invite.ics is the outsider's copy: no description
  // (the visitor's note stays with the host), title, place and names defanged,
  // a call link only on a known video-call host.
  const guestLines = [
    kind === "canceled" ? L("mail.guestCanceledBody") : L("mail.bookedBody", { host: defang(link.hostName) }),
    "",
    L("mail.when", { when: guestWhen }),
    ...(r.location ? [L("mail.where", { where: defang(r.location) })] : []),
    ...(r.conference && kind !== "canceled" && knownMeetingUrl(r.conference) ? [L("mail.join", { url: r.conference })] : []),
    ...(token && kind !== "canceled" ? ["", L("mail.manage", { url: manageUrl(r.slug, token) })] : []),
    "",
    L("mail.footer"),
  ];
  const guestSubject = kind === "canceled" ? L("mail.guestCanceledSubject", { when: guestWhen }) : kind === "moved" ? L("mail.guestMovedSubject", { when: guestWhen }) : L("mail.guestBookedSubject", { when: guestWhen });
  try {
    await sendMail({ to: b.email, subject: guestSubject, text: guestLines.join("\n"), attachments: icsFile(true) });
  } catch {
    // Mail trouble never undoes a booking.
  }
  const host = hostMail(r);
  if (!host.email) return;
  const H = (k: Parameters<typeof calText>[1], v?: Record<string, string | number>) => calText(host.locale, k, v);
  const hostWhen = whenLine(ev, host.locale, r.tz);
  const subject = kind === "booked" ? H("mail.newBookingSubject", { name: b.name, title: r.title }) : kind === "canceled" ? H("mail.bookingCanceledSubject", { title: r.title, name: b.name }) : H("mail.bookingMovedSubject", { title: r.title, name: b.name });
  const lines = [H("mail.newBookingBody", { name: b.name, email: b.email, title: r.title }), "", H("mail.when", { when: hostWhen }), ...(b.note && kind === "booked" ? ["", H("mail.note", { note: b.note })] : []), "", H("mail.footer")];
  try {
    await sendMail({ to: host.email, subject, text: lines.join("\n"), attachments: kind === "canceled" ? [] : icsFile(false) });
  } catch {
    // As above.
  }
}

/** Books a time on a link (the visitor is not signed in). */
export async function book(slug: unknown, input: BookInput, now = Date.now()): Promise<{ id: string; start: number; end: number; manage: string }> {
  const link = publicLink(slug);
  if (!link) throw new CalError(404, "not found");
  const r = link.row;
  const start = Number(input.start);
  const name = typeof input.name === "string" ? input.name.replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 100) : "";
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const note = typeof input.note === "string" ? input.note.replace(/\u0000/g, "").trim().slice(0, 1000) : "";
  const tz = validTimeZone(input.tz) ? input.tz : r.tz;
  const locale = typeof input.locale === "string" && /^[a-z]{2}$/.test(input.locale) ? input.locale : "en";
  if (!Number.isFinite(start) || !name || !EMAIL_RE.test(email)) throw new CalError(400, "bad request");
  // A few open bookings per e-mail per link, and a few new ones a day per e-mail anywhere.
  const open = Number((sql("SELECT COUNT(*) AS n FROM cal_bookings WHERE link_id = ? AND email = ? AND status = 'booked' AND start_at > ?").get(r.id, email, now) as { n: number }).n);
  const today = Number((sql("SELECT COUNT(*) AS n FROM cal_bookings WHERE email = ? AND created_at > ?").get(email, now - 86_400_000) as { n: number }).n);
  if (open >= 3 || today >= 5) throw new CalError(429, "limit");
  // …and a cap per link and per host a day: a link cannot become a mailer.
  const perLink = Number((sql("SELECT COUNT(*) AS n FROM cal_bookings WHERE link_id = ? AND created_at > ?").get(r.id, now - 86_400_000) as { n: number }).n);
  const perHost = Number((sql("SELECT COUNT(*) AS n FROM cal_bookings b JOIN cal_links l ON l.id = b.link_id WHERE l.user_id = ? AND b.created_at > ?").get(r.user_id, now - 86_400_000) as { n: number }).n);
  if (perLink >= LINK_DAILY_CAP || perHost >= HOST_DAILY_CAP) throw new CalError(429, "limit");
  const end = start + r.duration * 60_000;
  const token = newToken(24);
  const bookingId = newId(12);
  const ev = tx(() => {
    if (!slotsOf(r, start, start + 1, now).includes(start)) throw new CalError(409, "taken");
    const row = bookingEvent(link, { name, email, note, start, end, bookingId }, now);
    putRow(row);
    sql("INSERT INTO cal_attendees (event_id, email, user_id, name, rsvp, invited_at, responded_at) VALUES (?, ?, NULL, ?, 'accepted', ?, ?)").run(row.id, email, name, now, now);
    sql("INSERT INTO cal_bookings (id, link_id, event_id, name, email, note, start_at, end_at, tz, locale, token_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?)").run(
      bookingId,
      r.id,
      row.id,
      name,
      email,
      note,
      start,
      end,
      tz,
      locale,
      tokenHash("cal-booking", token),
      now,
      now
    );
    return eventRow(row.id) as EvRow;
  });
  afterWrite({ ws: r.ws_id, by: null, seriesIds: [ev.id], calIds: [r.cal_id], notifyGuests: false });
  const hostLocale = localeOf(r.user_id);
  notify(r.user_id, { ws: r.ws_id, kind: "invite", ref: `event:${ev.id}`, by: null, text: calText(hostLocale, "inbox.booked", { name, title: r.title, when: whenLine(ev, hostLocale, r.tz) }) });
  void letters(link, { name, email, note, locale, tz }, ev, "booked", token);
  return { id: bookingId, start, end, manage: manageUrl(r.slug, token) };
}

export interface ManagedBooking {
  booking: BookingRow;
  link: PublicLink;
}

/** The booking a guest's private link names (on a still-bookable link), or null. */
export function bookingByToken(slug: unknown, token: unknown): ManagedBooking | null {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  calDb();
  const b = sql("SELECT * FROM cal_bookings WHERE token_hash = ?").get(tokenHash("cal-booking", token)) as BookingRow | undefined;
  if (!b) return null;
  const linkRow = sql("SELECT slug FROM cal_links WHERE id = ?").get(b.link_id) as { slug: string } | undefined;
  if (!linkRow || linkRow.slug !== slug) return null;
  const link = publicLink(linkRow.slug);
  return link ? { booking: b, link } : null;
}

export async function cancelBooking(slug: unknown, token: unknown, now = Date.now()): Promise<void> {
  const m = bookingByToken(slug, token);
  if (!m) throw new CalError(404, "not found");
  if (m.booking.status === "canceled") return;
  const ev = m.booking.event_id ? eventRow(m.booking.event_id) : null;
  tx(() => {
    sql("UPDATE cal_bookings SET status = 'canceled', updated_at = ? WHERE id = ?").run(now, m.booking.id);
    if (ev && !ev.deleted_at) sql("UPDATE cal_events SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, ev.id);
  });
  if (!ev) return;
  afterWrite({ ws: m.link.row.ws_id, by: null, seriesIds: [ev.id], calIds: [ev.cal_id], notifyGuests: false });
  const hostLocale = localeOf(m.link.row.user_id);
  notify(m.link.row.user_id, { ws: m.link.row.ws_id, kind: "invite", ref: `event:${ev.id}`, by: null, text: calText(hostLocale, "inbox.bookingCanceled", { name: m.booking.name, title: m.link.row.title, when: whenLine(ev, hostLocale, m.link.row.tz) }) });
  void letters(m.link, m.booking, ev, "canceled", null);
}

export async function rescheduleBooking(slug: unknown, token: unknown, startIn: unknown, now = Date.now()): Promise<{ start: number; end: number }> {
  const m = bookingByToken(slug, token);
  if (!m || m.booking.status === "canceled") throw new CalError(404, "not found");
  const r = m.link.row;
  const start = Number(startIn);
  if (!Number.isFinite(start)) throw new CalError(400, "bad request");
  const end = start + r.duration * 60_000;
  const ev = m.booking.event_id ? eventRow(m.booking.event_id) : null;
  const updated = tx(() => {
    if (!slotsOf(r, start, start + 1, now, { event: ev?.id, booking: m.booking.id }).includes(start)) throw new CalError(409, "taken");
    sql("UPDATE cal_bookings SET start_at = ?, end_at = ?, updated_at = ? WHERE id = ?").run(start, end, now, m.booking.id);
    if (ev && !ev.deleted_at) {
      putRow({ ...ev, start_at: start, end_at: end, start_day: dayOf(start, ev.tz), end_day: dayOf(end, ev.tz), sequence: ev.sequence + 1, updated_at: now });
      return eventRow(ev.id);
    }
    return null;
  });
  if (updated) {
    afterWrite({ ws: r.ws_id, by: null, seriesIds: [updated.id], calIds: [updated.cal_id], notifyGuests: false });
    const hostLocale = localeOf(r.user_id);
    notify(r.user_id, { ws: r.ws_id, kind: "invite", ref: `event:${updated.id}`, by: null, text: calText(hostLocale, "inbox.bookingMoved", { name: m.booking.name, title: r.title, when: whenLine(updated, hostLocale, r.tz) }) });
    void letters(m.link, m.booking, updated, "moved", null);
  }
  return { start, end };
}

// ------------------------------------------------------------ what the public pages render

export interface PageData {
  now: number;
  slots: number[];
  link: { slug: string; title: string; description: string; duration: number; hostName: string; location: string; video: boolean; tz: string; windowDays: number; color: string };
  managed?: { token: string; name: string; email: string; start: number; end: number; tz: string; canceled: boolean };
}

function viewOf(link: PublicLink): PageData["link"] {
  const r = link.row;
  // The video call's address is sent with the invitation only.
  return { slug: r.slug, title: r.title, description: r.description, duration: r.duration, hostName: link.hostName, location: r.location, video: Boolean(r.conference), tz: r.tz, windowDays: r.window_days, color: r.color };
}

/** The booking page of a link: its public words and the free times of the next three weeks; null when it is off. */
export function bookingPage(slug: unknown, now = Date.now()): PageData | null {
  const link = publicLink(slug);
  if (!link) return null;
  return { now, slots: slotsOf(link.row, now, now + 21 * 86_400_000, now), link: viewOf(link) };
}

/** A guest's page for their booking (the token is the proof). */
export function managePage(slug: unknown, token: string, now = Date.now()): PageData | null {
  const m = bookingByToken(slug, token);
  if (!m) return null;
  const b = m.booking;
  return {
    now,
    slots: b.status === "booked" ? slotsOf(m.link.row, now, now + 21 * 86_400_000, now, { event: b.event_id, booking: b.id }) : [],
    link: viewOf(m.link),
    managed: { token, name: b.name, email: b.email, start: b.start_at, end: b.end_at, tz: b.tz, canceled: b.status === "canceled" },
  };
}
