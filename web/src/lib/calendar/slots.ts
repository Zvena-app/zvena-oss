// zvena Calendar: the free times of a scheduling link (Notion Calendar's
// "Share availability"). Pure: the server hands in the host's busy times and
// gets back the starts a visitor may book — nothing about what the host is
// busy with ever reaches the page.

import { addDays, atMinute, dayOf, weekday } from "./tz";

/** Weekly hours: weekday (0 Sunday … 6 Saturday) → [start, end) minute ranges of the host's day. */
export type WeeklyHours = Record<number, [number, number][]>;

export interface Availability {
  /** The host's zone: the hours are read on its wall clock. */
  tz: string;
  weekly: WeeklyHours;
  /** Meeting length, minutes. */
  duration: number;
  /** Starts are this many minutes apart (15, 30, 60, or the meeting's length). */
  step: number;
  /** Free time kept before and after every busy time, minutes. */
  bufferBefore: number;
  bufferAfter: number;
  /** No booking sooner than this many minutes from now. */
  noticeMin: number;
  /** Bookable this many days ahead (counted from today in the host's zone). */
  windowDays: number;
  /** At most this many bookings a day (0: no limit). */
  maxPerDay: number;
}

export const DEFAULT_WEEKLY: WeeklyHours = { 0: [], 1: [[540, 1020]], 2: [[540, 1020]], 3: [[540, 1020]], 4: [[540, 1020]], 5: [[540, 1020]], 6: [] };

/** Cleans weekly hours from a request: sorted, merged, inside the day, at most 6 ranges a day. */
export function cleanWeekly(v: unknown): WeeklyHours | null {
  if (!v || typeof v !== "object") return null;
  const out: WeeklyHours = {};
  for (let d = 0; d < 7; d++) {
    const raw = (v as Record<string, unknown>)[d] ?? (v as Record<string, unknown>)[String(d)];
    const list: [number, number][] = [];
    if (Array.isArray(raw)) {
      for (const r of raw.slice(0, 12)) {
        if (!Array.isArray(r) || r.length !== 2) return null;
        const a = Math.round(Number(r[0]));
        const b = Math.round(Number(r[1]));
        if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b > 1440 || b - a < 5) return null;
        list.push([a, b]);
      }
    }
    list.sort((x, y) => x[0] - y[0]);
    const merged: [number, number][] = [];
    for (const r of list) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    out[d] = merged.slice(0, 6);
  }
  return out;
}

export interface Busy {
  start: number;
  end: number;
}

export interface SlotQuery {
  avail: Availability;
  busy: readonly Busy[];
  /** Bookings already made per host day ("YYYY-MM-DD"), for maxPerDay. */
  bookedPerDay?: ReadonlyMap<string, number>;
  /** Only starts in [from, to). */
  from: number;
  to: number;
  now: number;
}

/** At most this many starts in one answer. */
const MAX_SLOTS = 2000;

/** Bookable starts (instants, ascending). */
export function freeSlots(q: SlotQuery): number[] {
  const a = q.avail;
  const dur = a.duration * 60_000;
  const step = Math.max(5, a.step) * 60_000;
  const earliest = q.now + a.noticeMin * 60_000;
  const today = dayOf(q.now, a.tz);
  const lastDay = addDays(today, Math.max(0, a.windowDays - 1));
  const busy = q.busy.map((b) => ({ start: b.start - a.bufferBefore * 60_000, end: b.end + a.bufferAfter * 60_000 })).sort((x, y) => x.start - y.start);
  const out: number[] = [];
  const first = dayOf(Math.max(q.from, q.now), a.tz);
  for (let day = first; day <= lastDay && out.length < MAX_SLOTS; day = addDays(day, 1)) {
    if (a.maxPerDay > 0 && (q.bookedPerDay?.get(day) ?? 0) >= a.maxPerDay) continue;
    const dayStartMs = atMinute(day, 0, a.tz);
    if (dayStartMs >= q.to) break;
    for (const [open, close] of a.weekly[weekday(day)] ?? []) {
      const closeMs = atMinute(day, close, a.tz);
      for (let s = atMinute(day, open, a.tz); s + dur <= closeMs; s += step) {
        if (s < earliest || s < q.from || s >= q.to) continue;
        const e = s + dur;
        if (busy.some((b) => b.start < e && b.end > s)) continue;
        out.push(s);
        if (out.length >= MAX_SLOTS) break;
      }
    }
  }
  return out;
}

/** Whether one start is bookable right now (the server checks again on booking). */
export function slotIsFree(q: Omit<SlotQuery, "from" | "to">, start: number): boolean {
  return freeSlots({ ...q, from: start, to: start + 1 }).includes(start);
}
