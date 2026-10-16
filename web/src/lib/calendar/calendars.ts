// Server-only: calendars and each person's settings. A person has a
// calendar of their own in every workspace they are a member of (made on
// first visit), can make more, share one with members (free/busy, view,
// edit), subscribe to an ICS address, connect a CalDAV calendar, and publish
// any calendar as a secret ICS feed (a token only its owner sees; reset or
// turn off at any time).

import { config } from "../config";
import { newId, sql, tx } from "../store";
import { atLeast, CalAccess, calRow, forgetAccess, type CalRow } from "./access";
import { calDb } from "./db";
import { CalError, parseJson } from "./events";
import { newToken, open, seal, tokenHash } from "./seal";
import { validTimeZone } from "./tz";
import { CAL_COLORS, COLOR_RE, DEFAULT_PREFS, WS_ACCESS, type CalendarInfo, type CalLevel, type Prefs, type Reminder, type ViewKind, type WsAccess } from "./types";
import { publishingAllowed } from "../enterprise/security";
import { queueIndex } from "./effects";

const NAME_MAX = 120;

function cleanName(v: unknown, fallback?: string): string {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== "string") throw new CalError(400, "bad name");
  const s = v.replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
  if (!s) throw new CalError(400, "name required");
  return s;
}

function cleanColor(v: unknown, fallback: string): string {
  if (v === undefined) return fallback;
  if (typeof v !== "string" || !COLOR_RE.test(v)) throw new CalError(400, "bad color");
  return v;
}

/** A color not yet taken by the person's calendars (Notion Calendar gives each new one its own). */
function nextColor(acc: CalAccess): string {
  const used = new Set((sql("SELECT color FROM cal_calendars WHERE ws_id = ? AND owner_id = ? AND deleted_at IS NULL").all(acc.ws, acc.userId) as { color: string }[]).map((r) => r.color));
  return CAL_COLORS.find((c) => !used.has(c)) ?? CAL_COLORS[used.size % CAL_COLORS.length];
}

/** The person's own calendar in this workspace (made on first use, named after them). */
export function ensureDefault(acc: CalAccess, name: string, tz: string, now = Date.now()): CalRow | null {
  calDb();
  if (!acc.member) return null;
  const have = sql("SELECT * FROM cal_calendars WHERE ws_id = ? AND owner_id = ? AND is_default = 1 AND deleted_at IS NULL").get(acc.ws, acc.userId) as CalRow | undefined;
  if (have) return have;
  const id = newId(12);
  sql("INSERT INTO cal_calendars (id, ws_id, owner_id, name, color, tz, kind, is_default, ws_access, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'local', 1, 'busy', ?, ?)").run(
    id,
    acc.ws,
    acc.userId,
    name.slice(0, NAME_MAX) || "Calendar",
    CAL_COLORS[0],
    validTimeZone(tz) ? tz : "UTC",
    now,
    now
  );
  return calRow(id);
}

function sharesOf(calId: string): { userId: string; name: string; level: Exclude<CalLevel, "owner"> }[] {
  return (sql("SELECT s.user_id, s.level, u.name FROM cal_shares s JOIN users u ON u.id = s.user_id WHERE s.cal_id = ? ORDER BY s.created_at").all(calId) as { user_id: string; level: Exclude<CalLevel, "owner">; name: string }[]).map((r) => ({
    userId: r.user_id,
    name: r.name,
    level: r.level,
  }));
}

export function calendarInfo(acc: CalAccess, c: CalRow, view?: { hidden: number; color: string | null } | null): CalendarInfo {
  const level = acc.level(c) as CalLevel;
  const owner = level === "owner";
  const ownerName = (sql("SELECT name FROM users WHERE id = ?").get(c.owner_id) as { name: string } | undefined)?.name ?? "";
  return {
    id: c.id,
    name: c.name,
    color: view?.color && COLOR_RE.test(view.color) ? view.color : c.color,
    description: c.description,
    tz: c.tz,
    kind: c.kind,
    isDefault: c.is_default === 1,
    wsAccess: c.ws_access,
    level,
    ownerId: c.owner_id,
    ownerName,
    hidden: view?.hidden === 1,
    readOnly: c.kind === "ics" || !atLeast(level, "edit"),
    ...(owner
      ? {
          ...(c.source_url ? { sourceUrl: c.source_url } : {}),
          syncedAt: c.synced_at,
          syncError: c.sync_error,
          shares: sharesOf(c.id),
          hasFeed: Boolean(c.feed_hash),
        }
      : {}),
  };
}

/** The calendars the person reads in the workspace, theirs first. */
export function listCalendars(acc: CalAccess): CalendarInfo[] {
  calDb();
  const rows = (sql("SELECT * FROM cal_calendars WHERE ws_id = ? AND deleted_at IS NULL ORDER BY is_default DESC, created_at").all(acc.ws) as unknown as CalRow[]).filter((c) => acc.canRead(c));
  const views = new Map((sql("SELECT cal_id, hidden, color FROM cal_view WHERE user_id = ?").all(acc.userId) as { cal_id: string; hidden: number; color: string | null }[]).map((v) => [v.cal_id, v]));
  return rows.map((c) => calendarInfo(acc, c, views.get(c.id))).sort((a, b) => Number(b.level === "owner") - Number(a.level === "owner"));
}

export interface CalendarInput {
  name?: unknown;
  color?: unknown;
  description?: unknown;
  tz?: unknown;
  wsAccess?: unknown;
}

function cleanAccess(v: unknown, fallback: WsAccess): WsAccess {
  if (v === undefined) return fallback;
  if (!WS_ACCESS.includes(v as WsAccess)) throw new CalError(400, "bad access");
  return v as WsAccess;
}

/** A new calendar of the person's own. */
export function createCalendar(acc: CalAccess, input: CalendarInput, extra: Partial<Pick<CalRow, "kind" | "source_url" | "account_id" | "remote_href">> = {}, now = Date.now()): CalRow {
  if (!acc.member) throw new CalError(403, "forbidden");
  const count = (sql("SELECT COUNT(*) AS n FROM cal_calendars WHERE ws_id = ? AND owner_id = ? AND deleted_at IS NULL").get(acc.ws, acc.userId) as { n: number }).n;
  if (Number(count) >= 100) throw new CalError(429, "too many calendars");
  const id = newId(12);
  const tz = input.tz !== undefined ? (validTimeZone(input.tz) ? input.tz : null) : prefsOf(acc.userId).tz;
  if (!tz) throw new CalError(400, "bad tz");
  sql(
    "INSERT INTO cal_calendars (id, ws_id, owner_id, name, color, description, tz, kind, ws_access, source_url, account_id, remote_href, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    id,
    acc.ws,
    acc.userId,
    cleanName(input.name),
    cleanColor(input.color, nextColor(acc)),
    typeof input.description === "string" ? input.description.slice(0, 2000) : "",
    tz,
    extra.kind ?? "local",
    cleanAccess(input.wsAccess, extra.kind === "ics" ? "none" : "busy"),
    extra.source_url ?? null,
    extra.account_id ?? null,
    extra.remote_href ?? null,
    now,
    now
  );
  return calRow(id) as CalRow;
}

function ownCalendar(acc: CalAccess, id: unknown): CalRow {
  const c = calRow(id);
  if (!c || !acc.canRead(c)) throw new CalError(404, "calendar not found");
  if (acc.level(c) !== "owner") throw new CalError(403, "owner only");
  return c;
}

/** The owner changes a calendar; anyone who reads it changes only how it looks to them (hidden, color). */
export function updateCalendar(acc: CalAccess, id: string, input: CalendarInput & { hidden?: unknown; viewColor?: unknown }, now = Date.now()): CalRow {
  const c = calRow(id);
  if (!c || !acc.canRead(c)) throw new CalError(404, "calendar not found");
  if (input.hidden !== undefined || input.viewColor !== undefined) {
    const cur = sql("SELECT hidden, color FROM cal_view WHERE user_id = ? AND cal_id = ?").get(acc.userId, id) as { hidden: number; color: string | null } | undefined;
    const hidden = input.hidden !== undefined ? (input.hidden === true ? 1 : 0) : (cur?.hidden ?? 0);
    const color = input.viewColor !== undefined ? (input.viewColor === null ? null : cleanColor(input.viewColor, c.color)) : (cur?.color ?? null);
    sql("INSERT INTO cal_view (user_id, cal_id, hidden, color) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, cal_id) DO UPDATE SET hidden = excluded.hidden, color = excluded.color").run(acc.userId, id, hidden, color);
  }
  const owned = ["name", "color", "description", "tz", "wsAccess"].some((k) => (input as Record<string, unknown>)[k] !== undefined);
  if (!owned) return c;
  if (acc.level(c) !== "owner") throw new CalError(403, "owner only");
  const tz = input.tz !== undefined ? (validTimeZone(input.tz) ? input.tz : null) : c.tz;
  if (!tz) throw new CalError(400, "bad tz");
  sql("UPDATE cal_calendars SET name = ?, color = ?, description = ?, tz = ?, ws_access = ?, updated_at = ? WHERE id = ?").run(
    cleanName(input.name, c.name),
    cleanColor(input.color, c.color),
    typeof input.description === "string" ? input.description.slice(0, 2000) : c.description,
    tz,
    cleanAccess(input.wsAccess, c.ws_access),
    now,
    id
  );
  forgetAccess();
  return calRow(id) as CalRow;
}

/** The owner deletes a calendar (not their own default one); its events go with it. */
export function deleteCalendar(acc: CalAccess, id: string, now = Date.now()): CalRow {
  const c = ownCalendar(acc, id);
  if (c.is_default === 1) throw new CalError(400, "the default calendar stays");
  tx(() => {
    sql("UPDATE cal_events SET deleted_at = ?, updated_at = ? WHERE cal_id = ? AND deleted_at IS NULL").run(now, now, id);
    sql("UPDATE cal_calendars SET deleted_at = ?, feed_hash = NULL, feed_token = NULL, updated_at = ? WHERE id = ?").run(now, now, id);
    sql("DELETE FROM cal_shares WHERE cal_id = ?").run(id);
    sql("UPDATE cal_links SET active = 0 WHERE cal_id = ?").run(id);
  });
  forgetAccess();
  // The shared search index and links forget its events (in the background: a calendar can be big).
  queueIndex(c.ws_id, (sql("SELECT id FROM cal_events WHERE cal_id = ? AND parent_id IS NULL").all(id) as { id: string }[]).map((r) => r.id));
  return c;
}

/** Shares a calendar with a member (or stops: level null). */
export function setShare(acc: CalAccess, id: string, userId: unknown, level: unknown, now = Date.now()): void {
  const c = ownCalendar(acc, id);
  if (typeof userId !== "string" || userId === acc.userId || !sql("SELECT 1 FROM members WHERE ws_id = ? AND user_id = ?").get(c.ws_id, userId)) throw new CalError(400, "not a member");
  if (level === null) sql("DELETE FROM cal_shares WHERE cal_id = ? AND user_id = ?").run(id, userId);
  else {
    if (level !== "busy" && level !== "view" && level !== "edit") throw new CalError(400, "bad level");
    sql("INSERT INTO cal_shares (cal_id, user_id, level, created_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(cal_id, user_id) DO UPDATE SET level = excluded.level").run(id, userId, level, acc.userId, now);
  }
  forgetAccess();
}

// ------------------------------------------------------------ the secret ICS feed

export function feedUrl(token: string): string {
  return `${config.appUrl}/api/calendar/feed/${token}.ics`;
}

/** The feed's address (the owner only), or null when it is off. */
export function feedOf(acc: CalAccess, id: string): string | null {
  const c = ownCalendar(acc, id);
  const token = open(c.feed_token, `feed:${c.id}`);
  return token ? feedUrl(token) : null;
}

/** Turns the feed on, or gives it a new address (the old one stops working at once). */
export function resetFeed(acc: CalAccess, id: string, now = Date.now()): string {
  const c = ownCalendar(acc, id);
  const token = newToken(24);
  sql("UPDATE cal_calendars SET feed_hash = ?, feed_token = ?, updated_at = ? WHERE id = ?").run(tokenHash("cal-feed", token), seal(token, `feed:${c.id}`), now, id);
  return feedUrl(token);
}

export function revokeFeed(acc: CalAccess, id: string, now = Date.now()): void {
  ownCalendar(acc, id);
  sql("UPDATE cal_calendars SET feed_hash = NULL, feed_token = NULL, updated_at = ? WHERE id = ?").run(now, id);
}

/** The calendar a feed token opens (its owner still a member), or null. */
export function calendarOfFeed(token: string): CalRow | null {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  calDb();
  const c = sql("SELECT * FROM cal_calendars WHERE feed_hash = ? AND deleted_at IS NULL").get(tokenHash("cal-feed", token)) as CalRow | undefined;
  if (!c) return null;
  // A feed of someone who left the workspace stops.
  if (!sql("SELECT 1 FROM members WHERE ws_id = ? AND user_id = ?").get(c.ws_id, c.owner_id)) return null;
  // A secret feed is publishing too (Settings → Security can switch it off).
  if (!publishingAllowed(c.ws_id)) return null;
  return c;
}

// ------------------------------------------------------------ settings

const VIEWS: readonly ViewKind[] = ["day", "week", "month", "agenda"];

/** Settings as stored, over the defaults (the zone: the person's Documents zone when unset). */
export function prefsOf(userId: string): Prefs {
  calDb();
  const row = sql("SELECT json FROM cal_prefs WHERE user_id = ?").get(userId) as { json: string } | undefined;
  const fallbackTz = (sql("SELECT tz FROM user_tz WHERE user_id = ?").get(userId) as { tz: string } | undefined)?.tz;
  const stored = parseJson<Partial<Prefs>>(row?.json, {});
  return { ...DEFAULT_PREFS, tz: validTimeZone(fallbackTz) ? fallbackTz : DEFAULT_PREFS.tz, ...stored };
}

export function prefsSaved(userId: string): boolean {
  calDb();
  return Boolean(sql("SELECT 1 FROM cal_prefs WHERE user_id = ? AND json != ''").get(userId));
}

/** Remembers the person's interface language (what letters to them are written in). */
export function rememberLocale(userId: string, locale: string, now = Date.now()): void {
  calDb();
  sql("INSERT INTO cal_prefs (user_id, json, locale, updated_at) VALUES (?, '', ?, ?) ON CONFLICT(user_id) DO UPDATE SET locale = excluded.locale").run(userId, locale.slice(0, 8), now);
}

export function localeOf(userId: string | null): string {
  if (!userId) return "en";
  calDb();
  return (sql("SELECT locale FROM cal_prefs WHERE user_id = ?").get(userId) as { locale: string } | undefined)?.locale ?? "en";
}

const minuteOk = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 1440;

/** Saves settings (only the known fields, each checked). */
export function savePrefs(userId: string, input: Record<string, unknown>, now = Date.now()): Prefs {
  const cur = prefsOf(userId);
  const next: Prefs = { ...cur };
  const bad = (k: string): never => {
    throw new CalError(400, `bad ${k}`);
  };
  if (input.tz !== undefined) next.tz = validTimeZone(input.tz) ? input.tz : bad("tz");
  if (input.zones !== undefined) {
    if (!Array.isArray(input.zones) || input.zones.length > 4 || !input.zones.every((z) => validTimeZone(z))) bad("zones");
    next.zones = [...new Set(input.zones as string[])];
  }
  if (input.weekStart !== undefined) next.weekStart = [-1, 0, 1, 6].includes(input.weekStart as number) ? (input.weekStart as number) : bad("weekStart");
  if (input.hour12 !== undefined) next.hour12 = input.hour12 === null ? null : input.hour12 === true;
  if (input.workStart !== undefined) next.workStart = minuteOk(input.workStart) ? (input.workStart as number) : bad("workStart");
  if (input.workEnd !== undefined) next.workEnd = minuteOk(input.workEnd) ? (input.workEnd as number) : bad("workEnd");
  if (next.workEnd <= next.workStart) bad("work hours");
  if (input.workDays !== undefined) {
    if (!Array.isArray(input.workDays) || !input.workDays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) bad("workDays");
    next.workDays = [...new Set(input.workDays as number[])].sort();
  }
  if (input.days !== undefined) next.days = Number.isInteger(input.days) && (input.days as number) >= 1 && (input.days as number) <= 7 ? (input.days as number) : bad("days");
  if (input.view !== undefined) next.view = VIEWS.includes(input.view as ViewKind) ? (input.view as ViewKind) : bad("view");
  if (input.showWeekends !== undefined) next.showWeekends = input.showWeekends !== false;
  if (input.defaultDuration !== undefined) next.defaultDuration = [15, 30, 45, 60, 90, 120].includes(input.defaultDuration as number) ? (input.defaultDuration as number) : bad("defaultDuration");
  if (input.defaultReminders !== undefined) {
    if (!Array.isArray(input.defaultReminders) || input.defaultReminders.length > 5) bad("defaultReminders");
    next.defaultReminders = (input.defaultReminders as Reminder[]).map((r) => {
      const min = Number(r?.min);
      if (!Number.isInteger(min) || min < 0 || min > 40_320) bad("reminder");
      return { min, how: r?.how === "email" ? "email" : "inbox" };
    });
  }
  if (input.dimPast !== undefined) next.dimPast = input.dimPast !== false;
  if (input.showDeclined !== undefined) next.showDeclined = input.showDeclined !== false;
  sql("INSERT INTO cal_prefs (user_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at").run(userId, JSON.stringify(next), now);
  return next;
}

/** Members of the workspace (guest pickers, "Meet with", shares). E-mails only for members who may see the directory. */
export function membersOf(acc: CalAccess): { id: string; name: string; email?: string }[] {
  if (!acc.member) return [];
  return (sql("SELECT u.id, u.name, u.email FROM members m JOIN users u ON u.id = m.user_id WHERE m.ws_id = ? ORDER BY u.name COLLATE NOCASE LIMIT 2000").all(acc.ws) as { id: string; name: string; email: string | null }[]).map((u) => ({
    id: u.id,
    name: u.name,
    ...(u.email ? { email: u.email } : {}),
  }));
}
