// Dates and times as Calendar shows them: always Intl in the interface's
// language (intlOf), on the calendar's zone, 12- or 24-hour as the person
// chose or as their language does. Pure.

import { intlOf, mondayFirstIn } from "@/i18n/locales";
import { dayNumber, parseDay, wallOf } from "@/lib/calendar/tz";
import type { Prefs } from "@/lib/calendar/types";

const cache = new Map<string, Intl.DateTimeFormat>();
function f(locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = `${locale}|${JSON.stringify(opts)}`;
  let x = cache.get(k);
  if (!x) {
    try {
      x = new Intl.DateTimeFormat(intlOf(locale), opts);
    } catch {
      x = new Intl.DateTimeFormat(intlOf(locale), { ...opts, timeZone: "UTC" });
    }
    cache.set(k, x);
  }
  return x;
}

/** Whether times read "1:00 PM": the person's choice, else their language's custom. */
export function uses12h(locale: string, pref: boolean | null | undefined): boolean {
  if (pref === true || pref === false) return pref;
  const hc = f(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
  return hc === "h12" || hc === "h11";
}

/** The first day of the week: the person's choice, else the language's (0 Sunday, 1 Monday, 6 Saturday). */
export function weekStartOf(prefs: Pick<Prefs, "weekStart">, locale: string): number {
  return prefs.weekStart >= 0 ? prefs.weekStart : mondayFirstIn(locale) ? 1 : 0;
}

const utcOf = (day: string) => {
  const p = parseDay(day);
  return new Date(Date.UTC(p.y, p.m - 1, p.d, 12));
};

/** "9:30 AM", "9 AM" (Notion Calendar drops ":00"), "21:30". */
export function fmtTime(ms: number, tz: string, locale: string, h12: boolean, compact = true): string {
  const w = wallOf(ms, tz);
  return f(locale, { hour: "numeric", ...(compact && w.mi === 0 ? {} : { minute: "2-digit" }), hour12: h12, timeZone: tz }).format(new Date(ms));
}

/** A minute of the day as a label ("9 AM", "09:00"), with no zone involved. */
export function fmtMinute(minute: number, locale: string, h12: boolean, compact = true): string {
  const d = new Date(Date.UTC(2001, 0, 1, Math.floor(minute / 60) % 24, minute % 60));
  return f(locale, { hour: "numeric", ...(compact && minute % 60 === 0 ? {} : { minute: "2-digit" }), hour12: h12, timeZone: "UTC" }).format(d);
}

export function fmtDay(day: string, locale: string, opts: Intl.DateTimeFormatOptions): string {
  return f(locale, { ...opts, timeZone: "UTC" }).format(utcOf(day));
}

export const weekdayShort = (day: string, locale: string) => fmtDay(day, locale, { weekday: "short" });
export const dayNum = (day: string, locale: string) => fmtDay(day, locale, { day: "numeric" });

/** The header's title: "October 2026" (or "Oct – Nov 2026" across months). */
export function rangeTitle(first: string, last: string, locale: string): { main: string; year: string } {
  const a = parseDay(first);
  const b = parseDay(last);
  const month = (d: string, long: boolean) => fmtDay(d, locale, { month: long ? "long" : "short" });
  const year = String(b.y === a.y ? a.y : `${a.y} – ${b.y}`);
  const yearText = fmtDay(last, locale, { year: "numeric" });
  if (a.m === b.m && a.y === b.y) return { main: month(first, true), year: yearText };
  return { main: `${month(first, false)} – ${month(last, false)}`, year: a.y === b.y ? yearText : year };
}

/** "Thu, Oct 15" */
export const fmtDate = (day: string, locale: string) => fmtDay(day, locale, { weekday: "short", month: "short", day: "numeric" });
export const fmtDateLong = (day: string, locale: string) => fmtDay(day, locale, { weekday: "long", month: "long", day: "numeric", year: "numeric" });

/** ISO week number of a day. */
export function isoWeek(day: string): number {
  const n = dayNumber(day);
  const wd = (((n + 3) % 7) + 7) % 7; // Monday 0
  const thursday = n - wd + 3;
  const year = new Date(thursday * 86_400_000).getUTCFullYear();
  const jan4 = Math.round(Date.UTC(year, 0, 4) / 86_400_000);
  const jan4wd = (((jan4 + 3) % 7) + 7) % 7;
  return 1 + Math.round((thursday - (jan4 - jan4wd + 3)) / 7);
}

/** "1h 30m"-style length in the language ("90 min" when shorter than two hours). */
export function fmtDuration(min: number, locale: string): string {
  try {
    const nf = (n: number, unit: "hour" | "minute") => new Intl.NumberFormat(intlOf(locale), { style: "unit", unit, unitDisplay: "short" }).format(n);
    if (min < 60) return nf(min, "minute");
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${nf(h, "hour")} ${nf(m, "minute")}` : nf(h, "hour");
  } catch {
    return `${min} min`;
  }
}

/** "in 5 minutes", "in 2 hours", "tomorrow", "in 3 days". */
export function fmtIn(ms: number, now: number, locale: string): string {
  const min = Math.max(0, Math.round((ms - now) / 60_000));
  const rtf = new Intl.RelativeTimeFormat(intlOf(locale), { numeric: "auto" });
  if (min < 60) return rtf.format(min, "minute");
  if (min < 24 * 60) return rtf.format(Math.round(min / 60), "hour");
  return rtf.format(Math.round(min / 1440), "day");
}
