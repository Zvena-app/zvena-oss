// zvena Calendar: time zones and calendar days without a library. Pure
// (browser, server, tests): Intl answers what the wall clock reads in a zone
// at an instant, and `fromWall` goes back, so 9:00 stays 9:00 across a
// daylight-saving change.
//
// A calendar day is "YYYY-MM-DD" (a civil date, no zone): all-day events,
// the grid's columns, recurrence. Instants are epoch milliseconds.

export interface Wall {
  y: number;
  /** 1–12 */
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

const ZONE_RE = /^(?:[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}|UTC|GMT|Etc\/[A-Za-z0-9+-]+)$/;
const fmtCache = new Map<string, Intl.DateTimeFormat>();

function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    fmtCache.set(tz, f);
  }
  return f;
}

/** An IANA zone Intl knows ("America/New_York", "UTC"). */
export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length > 64 || !ZONE_RE.test(tz)) return false;
  try {
    fmt(tz);
    return true;
  } catch {
    return false;
  }
}

/** The browser's zone, or UTC (the server and tests). */
export function localZone(): string {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return validTimeZone(z) ? z : "UTC";
  } catch {
    return "UTC";
  }
}

/** What the clock on the wall reads in `tz` at `ms`. */
export function wallOf(ms: number, tz: string): Wall {
  const parts = fmt(tz).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour") % 24, mi: get("minute"), s: get("second") };
}

/** The zone's offset from UTC at `ms`, in minutes (New York in winter: -300). */
export function offsetOf(ms: number, tz: string): number {
  const t = Math.floor(ms / 1000) * 1000;
  const w = wallOf(t, tz);
  return Math.round((Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - t) / 60_000);
}

const sameWall = (a: Wall, b: Wall) => a.y === b.y && a.m === b.m && a.d === b.d && a.h === b.h && a.mi === b.mi;

/**
 * The instant the wall clock in `tz` reads `w`. A time that happens twice
 * (clocks go back) is the first one; a time that never happens (clocks go
 * forward) moves forward by the gap, as RFC 5545 says.
 */
export function fromWall(w: Wall, tz: string): number {
  const utc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  const before = offsetOf(utc - 86_400_000, tz);
  const after = offsetOf(utc + 86_400_000, tz);
  const candidates = [...new Set([utc - before * 60_000, utc - after * 60_000])].sort((a, b) => a - b);
  for (const t of candidates) if (sameWall(wallOf(t, tz), w)) return t;
  // In a gap: the offset before the change carries the time past it.
  return utc - before * 60_000;
}

// ------------------------------------------------------------ calendar days

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function ymd(y: number, m: number, d: number): string {
  const t = new Date(Date.UTC(y, m - 1, d));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function isDay(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = DAY_RE.exec(v);
  return Boolean(m && ymd(Number(m[1]), Number(m[2]), Number(m[3])) === v);
}

export function parseDay(day: string): { y: number; m: number; d: number } {
  const m = DAY_RE.exec(day);
  if (!m) throw new Error(`bad day ${day}`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** Days since 1970-01-01 (for arithmetic). */
export function dayNumber(day: string): number {
  const p = parseDay(day);
  return Math.round(Date.UTC(p.y, p.m - 1, p.d) / 86_400_000);
}

export function dayFromNumber(n: number): string {
  const t = new Date(n * 86_400_000);
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export function addDays(day: string, n: number): string {
  return dayFromNumber(dayNumber(day) + n);
}

export function daysBetween(a: string, b: string): number {
  return dayNumber(b) - dayNumber(a);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(day: string): number {
  return (((dayNumber(day) + 4) % 7) + 7) % 7;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Months later, kept to the end of a shorter month. */
export function addMonths(day: string, n: number): string {
  const p = parseDay(day);
  const total = p.y * 12 + (p.m - 1) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return ymd(y, m, Math.min(p.d, daysInMonth(y, m)));
}

/** The first day of the week holding `day` (weekStart: 0 Sunday, 1 Monday, 6 Saturday). */
export function startOfWeek(day: string, weekStart: number): string {
  return addDays(day, -((weekday(day) - weekStart + 7) % 7));
}

export function startOfMonth(day: string): string {
  const p = parseDay(day);
  return ymd(p.y, p.m, 1);
}

/** The calendar day in `tz` at `ms`. */
export function dayOf(ms: number, tz: string): string {
  const w = wallOf(ms, tz);
  return ymd(w.y, w.m, w.d);
}

/** Minutes since midnight on the wall clock of `tz` at `ms`. */
export function minuteOfDay(ms: number, tz: string): number {
  const w = wallOf(ms, tz);
  return w.h * 60 + w.mi;
}

/** The instant a day starts in `tz` (midnight, or the first minute after a gap). */
export function dayStart(day: string, tz: string): number {
  const p = parseDay(day);
  return fromWall({ ...p, h: 0, mi: 0, s: 0 }, tz);
}

/** The instant of a wall time ("HH:mm" minutes since midnight) on a day in `tz`. */
export function atMinute(day: string, minute: number, tz: string): number {
  const p = parseDay(day);
  const extra = Math.floor(minute / 1440);
  const q = extra ? parseDay(addDays(day, extra)) : p;
  const m = minute - extra * 1440;
  return fromWall({ ...q, h: Math.floor(m / 60), mi: m % 60, s: 0 }, tz);
}

/** "UTC−5", "UTC+5:30": a zone's offset at `ms`, for the grid's zone labels. */
export function offsetLabel(ms: number, tz: string): string {
  const o = offsetOf(ms, tz);
  if (o === 0) return "UTC";
  const a = Math.abs(o);
  return `UTC${o < 0 ? "−" : "+"}${Math.floor(a / 60)}${a % 60 ? `:${pad(a % 60)}` : ""}`;
}

/** The zone's short name in a language ("EST", "GMT+5:30"), else its offset. */
export function zoneAbbr(ms: number, tz: string, intl = "en-US"): string {
  try {
    const p = new Intl.DateTimeFormat(intl, { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(ms)).find((x) => x.type === "timeZoneName");
    return p?.value ?? offsetLabel(ms, tz);
  } catch {
    return offsetLabel(ms, tz);
  }
}

/** The city of an IANA name ("America/New_York" → "New York"). */
export function zoneCity(tz: string): string {
  const last = tz.split("/").pop() ?? tz;
  return last.replace(/_/g, " ");
}

/** Every zone Intl lists (newer engines), else a short list of common ones. */
export function allZones(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone");
    if (list?.length) return list.includes("UTC") ? list : ["UTC", ...list];
  } catch {
    // Older engines.
  }
  return COMMON_ZONES;
}

export const COMMON_ZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Africa/Lagos",
  "Africa/Cairo",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Dhaka",
  "Asia/Jakarta",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];
