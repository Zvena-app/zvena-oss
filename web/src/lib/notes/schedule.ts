// zvena Documents: when a scheduled automation (or a repeating template) runs
// next. Times are wall-clock times of the workspace's time zone ("09:00 in
// Europe/Berlin"), so daylight-saving changes keep the hour. Pure logic, no
// dependencies: the offset of a zone comes from Intl.

import type { AutoTrigger } from "./automations";

export type ScheduleTrigger = Extract<AutoTrigger, { type: "schedule" }>;

export const DEFAULT_TZ = "UTC";

/** Whether `tz` is an IANA time zone this runtime knows. */
export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of an instant in a zone. */
export function zonedParts(ts: number, tz: string): { y: number; m: number; d: number; hh: number; mm: number; wd: number } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ts))) p[x.type] = x.value;
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh: Number(p.hour) % 24, mm: Number(p.minute), wd };
}

/** Minutes the zone is ahead of UTC at an instant. */
function offsetMin(ts: number, tz: string): number {
  const p = zonedParts(ts, tz);
  return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) - Math.floor(ts / 60_000) * 60_000) / 60_000);
}

/** The instant of a wall-clock time in a zone (a time skipped by DST moves forward). */
export function zonedTime(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ts = guess - offsetMin(guess, tz) * 60_000;
  // Near a DST change the offset at the result can differ from the guess's.
  const again = guess - offsetMin(ts, tz) * 60_000;
  if (again !== ts) ts = again;
  return ts;
}

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Calendar days between two dates (UTC-based, no time). */
const dayNo = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);

function weekdaysOf(t: ScheduleTrigger): number[] {
  if (t.weekdays?.length) return t.weekdays;
  return t.weekday !== undefined ? [t.weekday] : [1];
}

/** Whether the schedule runs on this local date. */
function runsOn(t: ScheduleTrigger, y: number, m: number, d: number, wd: number): boolean {
  const n = Math.max(1, t.interval ?? 1);
  const from = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t.from ?? "");
  const anchor = from ? { y: Number(from[1]), m: Number(from[2]), d: Number(from[3]) } : null;
  if (anchor && dayNo(y, m, d) < dayNo(anchor.y, anchor.m, anchor.d)) return false;
  switch (t.every) {
    case "day":
      return !anchor || (dayNo(y, m, d) - dayNo(anchor.y, anchor.m, anchor.d)) % n === 0;
    case "week": {
      if (!weekdaysOf(t).includes(wd)) return false;
      if (!anchor || n === 1) return true;
      // Weeks counted from the Monday of the anchor's week.
      const monday = (yy: number, mm: number, dd: number) => {
        const w = new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay();
        return dayNo(yy, mm, dd) - ((w + 6) % 7);
      };
      return Math.floor((monday(y, m, d) - monday(anchor.y, anchor.m, anchor.d)) / 7) % n === 0;
    }
    case "month": {
      // The 31st in a 30-day month is its last day (Notion).
      const want = Math.min(t.monthday ?? 1, daysIn(y, m));
      if (d !== want) return false;
      return !anchor || ((y - anchor.y) * 12 + (m - anchor.m)) % n === 0;
    }
    case "year": {
      if (m !== (t.month ?? 1)) return false;
      if (d !== Math.min(t.monthday ?? 1, daysIn(y, m))) return false;
      return !anchor || (y - anchor.y) % n === 0;
    }
  }
}

/** The first run strictly after `after` (null: none in the next ~13 months, e.g. a bad spec). */
export function nextRun(t: ScheduleTrigger, tz: string, after: number): number | null {
  const [hh, mm] = t.at.split(":").map(Number);
  const start = zonedParts(after, tz);
  for (let i = 0; i < 400 * Math.max(1, Math.min(t.interval ?? 1, 10)); i++) {
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    if (!runsOn(t, y, m, d, day.getUTCDay())) continue;
    const at = zonedTime(y, m, d, hh, mm, tz);
    if (at > after) return at;
  }
  return null;
}

/** Wall-clock "now" of a zone as a local Date (for relative dates such as "@today"). */
export function zonedNow(ts: number, tz: string): Date {
  const p = zonedParts(ts, tz);
  return new Date(p.y, p.m - 1, p.d, p.hh, p.mm);
}
