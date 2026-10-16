// What the views draw, computed from the state: the visible days, where an
// event or a Docs row sits on them, how far "next" goes. Pure.

import { addDays, addMonths, atMinute, dayOf, daysBetween, isDay, minuteOfDay, startOfMonth, startOfWeek, weekday } from "@/lib/calendar/tz";
import type { CalendarInfo, EventItem, LayerItem, Prefs, ViewKind } from "@/lib/calendar/types";

export interface ViewState {
  view: ViewKind;
  /** The day the view is about ("YYYY-MM-DD"). */
  anchor: string;
}

/** How many days the week view shows: on a phone (narrow) at most three, from the anchor (Google / Notion Calendar's 3-day view). */
export const narrowDays = (prefs: Pick<Prefs, "days">) => Math.max(1, Math.min(3, prefs.days));

/** The days a view shows, in order. */
export function visibleDays(s: ViewState, prefs: Pick<Prefs, "days" | "showWeekends">, weekStart: number, narrow: boolean): string[] {
  const view = s.view;
  if (view === "day") return [s.anchor];
  if (view === "agenda") return Array.from({ length: 30 }, (_, i) => addDays(s.anchor, i));
  if (view === "month") {
    const first = startOfWeek(startOfMonth(s.anchor), weekStart);
    const last = addDays(startOfMonth(addMonths(startOfMonth(s.anchor), 1)), -1);
    const weeks = Math.ceil((daysBetween(first, last) + 1) / 7);
    return Array.from({ length: weeks * 7 }, (_, i) => addDays(first, i));
  }
  const weekend = (d: string) => weekday(d) === 0 || weekday(d) === 6;
  const n = narrow ? narrowDays(prefs) : prefs.days;
  if (n >= 7) {
    const all = Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(s.anchor, weekStart), i));
    return prefs.showWeekends ? all : all.filter((d) => !weekend(d));
  }
  const out: string[] = [];
  for (let d = s.anchor; out.length < n; d = addDays(d, 1)) if (prefs.showWeekends || !weekend(d)) out.push(d);
  return out;
}

/** Where "next" (+1) or "previous" (-1) goes. */
export function step(s: ViewState, dir: 1 | -1, prefs: Pick<Prefs, "days">, narrow: boolean): string {
  const view = s.view;
  if (narrow && view === "week") return addDays(s.anchor, dir * narrowDays(prefs));
  if (view === "day") return addDays(s.anchor, dir);
  if (view === "month") return addMonths(startOfMonth(s.anchor), dir);
  if (view === "agenda") return addDays(s.anchor, 30 * dir);
  return addDays(s.anchor, dir * (prefs.days >= 7 ? 7 : prefs.days));
}

/** The color an event is drawn in: its own, else its calendar's. */
export function colorOf(e: Pick<EventItem, "color" | "calId">, cals: ReadonlyMap<string, CalendarInfo>): string {
  return e.color ?? cals.get(e.calId)?.color ?? "#2f80ed";
}

/** One piece of an event on one day of the grid (an overnight event is two pieces). */
export interface Piece {
  key: string;
  day: string;
  /** Minutes from midnight, on the grid's zone. */
  top: number;
  bottom: number;
  item: GridItem;
  /** The piece where the event starts / ends (rounded corners, the resize handle). */
  first: boolean;
  last: boolean;
}

/** Anything placed on the grid: an event occurrence or a layer item (Docs, Projects). */
export type GridItem =
  | { kind: "event"; key: string; event: EventItem; start: number; end: number; allDay: boolean; startDay: string; endDay: string }
  | { kind: "layer"; key: string; layer: LayerItem; start: number; end: number; allDay: boolean; startDay: string; endDay: string };

export const itemKey = (e: Pick<EventItem, "id" | "occ">) => `${e.id}|${e.occ ?? ""}`;

/** An event as a grid item. */
export function eventItem(e: EventItem): GridItem {
  return { kind: "event", key: itemKey(e), event: e, start: e.start, end: e.end, allDay: e.allDay, startDay: e.startDay, endDay: e.endDay };
}

const TIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;

/** A Docs row or a Projects date as a grid item: Docs times are on the viewer's own wall clock. */
export function layerItem(l: LayerItem, tz: string): GridItem | null {
  const s = TIME_RE.exec(l.start);
  if (s) {
    const start = atMinute(s[1], Number(s[2]) * 60 + Number(s[3]), tz);
    const e = l.end ? TIME_RE.exec(l.end) : null;
    let end = e ? atMinute(e[1], Number(e[2]) * 60 + Number(e[3]), tz) : start + 60 * 60_000;
    if (end <= start) end = start + 30 * 60_000;
    return { kind: "layer", key: l.key, layer: l, start, end, allDay: false, startDay: dayOf(start, tz), endDay: dayOf(end, tz) };
  }
  const d = l.start.slice(0, 10);
  if (!isDay(d)) return null;
  const last = l.end && isDay(l.end.slice(0, 10)) && l.end.slice(0, 10) >= d ? l.end.slice(0, 10) : d;
  return { kind: "layer", key: l.key, layer: l, start: atMinute(d, 0, tz), end: atMinute(addDays(last, 1), 0, tz), allDay: true, startDay: d, endDay: addDays(last, 1) };
}

/** Timed items cut into per-day pieces on the visible days. */
export function piecesOf(items: readonly GridItem[], days: readonly string[], tz: string): Piece[] {
  const shown = new Set(days);
  const out: Piece[] = [];
  for (const it of items) {
    if (it.allDay) continue;
    const firstDay = dayOf(it.start, tz);
    const lastDay = dayOf(Math.max(it.start, it.end - 1), tz);
    for (let d = firstDay; d <= lastDay; d = addDays(d, 1)) {
      if (!shown.has(d)) continue;
      const top = d === firstDay ? minuteOfDay(it.start, tz) : 0;
      const bottom = d === lastDay ? (it.end === it.start ? top + 15 : minuteOfDay(it.end, tz) || 1440) : 1440;
      out.push({ key: `${it.key}@${d}`, day: d, top, bottom: Math.max(bottom, top + 1), item: it, first: d === firstDay, last: d === lastDay });
      if (daysBetween(firstDay, d) > 40) break;
    }
  }
  return out;
}

/** All-day (and multi-day) items as bars over day indexes [from, to] of `days`. */
export function barsOf(items: readonly GridItem[], days: readonly string[]): { id: string; from: number; to: number; item: GridItem; clipStart: boolean; clipEnd: boolean }[] {
  if (!days.length) return [];
  const first = days[0];
  const last = days[days.length - 1];
  const idx = new Map(days.map((d, i) => [d, i]));
  const out: { id: string; from: number; to: number; item: GridItem; clipStart: boolean; clipEnd: boolean }[] = [];
  for (const it of items) {
    if (!it.allDay) continue;
    const lastDay = addDays(it.endDay, -1);
    if (lastDay < first || it.startDay > last) continue;
    // Days hidden from the view (weekends off) are skipped over.
    let from = idx.get(it.startDay);
    let to = idx.get(lastDay);
    if (from === undefined) from = days.findIndex((d) => d >= it.startDay);
    if (to === undefined) {
      const later = days.findIndex((d) => d > lastDay);
      to = (later < 0 ? days.length : later) - 1;
    }
    if (from < 0 || to < from) continue;
    out.push({ id: it.key, from, to, item: it, clipStart: it.startDay < first, clipEnd: lastDay > last });
  }
  return out;
}

/** A link to an event (what "Copy link" copies). */
export function eventLink(origin: string, ws: string, e: Pick<EventItem, "id" | "occ">): string {
  return `${origin}/calendar?ws=${encodeURIComponent(ws)}&event=${encodeURIComponent(e.id)}${e.occ ? `&occ=${encodeURIComponent(e.occ)}` : ""}`;
}

/** The conferencing link of an event: its own, else a meeting link in its place. */
export function joinUrl(e: Pick<EventItem, "conference" | "location">): string | null {
  if (e.conference) return e.conference;
  const m = /https:\/\/(?:[\w-]+\.)?(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|whereby\.com|meet\.jit\.si|webex\.com|around\.co)\/[^\s<>"']*/i.exec(e.location ?? "");
  return m ? m[0] : null;
}

/** The next event that is not over (the rail's "next" card, ⌘J). */
export function nextEvent(items: readonly EventItem[], now: number): EventItem | null {
  return items.filter((e) => !e.allDay && e.end > now && e.rsvp !== "declined" && e.status !== "cancelled").sort((a, b) => a.start - b.start)[0] ?? null;
}
