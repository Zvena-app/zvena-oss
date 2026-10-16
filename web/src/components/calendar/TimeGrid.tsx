"use client";

// The day and week views (Notion Calendar's time grid): an all-day row, the
// hours of the primary zone with more zones side by side, events laid out
// in their day columns, the current-time line, teammates' busy times.
//
// Pointer: press on empty time and drag to make an event (a click makes one
// of the default length); drag an event to move it, its bottom edge to
// change its end; Esc while dragging puts it back. 15-minute steps.
// Touch: a tap opens an event or makes one in the empty slot; press and hold
// (Google Calendar) to drag one, or to draw a new one; a swipe scrolls.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Repeat, Users, Video } from "lucide-react";
import { layoutBars, layoutDay } from "@/lib/calendar/layout";
import { addDays, atMinute, dayOf, daysBetween, minuteOfDay, zoneAbbr, zoneCity } from "@/lib/calendar/tz";
import type { CalendarInfo, Prefs } from "@/lib/calendar/types";
import { dayNum, fmtMinute, fmtTime, weekdayShort } from "./format";
import type { CT } from "./i18n";
import { barsOf, colorOf, piecesOf, type GridItem, type Piece } from "./model";
import { swallowClick } from "./ui";

export const PX_PER_MIN = 0.8;
const SNAP = 15;
const snap = (m: number, s = SNAP) => Math.round(m / s) * s;
const floorTo = (m: number, s = SNAP) => Math.floor(m / s) * s;
/** How long a finger rests before a drag starts (shorter is a tap, moving first is a scroll). */
const HOLD_MS = 380;

export interface BusyOverlay {
  userId: string;
  name: string;
  color: string;
  busy: { start: number; end: number; allDay: boolean; title?: string }[];
}

export type MoveTarget = { start: number; end: number } | { startDay: string; endDay: string };

export interface GridProps {
  days: readonly string[];
  tz: string;
  zones: readonly string[];
  locale: string;
  h12: boolean;
  items: readonly GridItem[];
  overlays: readonly BusyOverlay[];
  cals: ReadonlyMap<string, CalendarInfo>;
  prefs: Prefs;
  now: number;
  today: string;
  selected: string | null;
  t: CT;
  onSelect: (item: GridItem) => void;
  onCreate: (r: MoveTarget) => void;
  onMove: (item: GridItem, to: MoveTarget) => void;
  onDay: (day: string) => void;
}

interface Drag {
  mode: "create" | "move" | "resize";
  pointerId: number;
  x0: number;
  y0: number;
  day0: number;
  minute0: number;
  item?: GridItem;
  /** The item's start in minutes from midnight of the pressed column (negative: it began a day before). */
  rel?: number;
  dur?: number;
  moved: boolean;
  /** Started by a finger (after a press and hold): the event stays in place, faded, under the finger. */
  touch?: boolean;
  cur: { day: number; top: number; bottom: number };
}

interface BarDrag {
  mode: "create" | "move";
  pointerId: number;
  x0: number;
  day0: number;
  item?: GridItem;
  moved: boolean;
  cur: { from: number; to: number };
}

export function canDrag(it: GridItem): boolean {
  return it.kind === "event" ? it.event.canEdit : it.layer.canEdit;
}

function title(it: GridItem, t: CT): string {
  const s = it.kind === "event" ? it.event.title : it.layer.title;
  return s || t("ev.untitled");
}

export function TimeGrid(p: GridProps) {
  const { days, tz, t } = p;
  const scroll = useRef<HTMLDivElement>(null);
  const cols = useRef<(HTMLDivElement | null)[]>([]);
  const barArea = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [bar, setBar] = useState<BarDrag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const putDrag = (v: Drag | null) => {
    dragRef.current = v;
    setDrag(v);
  };
  const barRef = useRef<BarDrag | null>(null);
  const putBar = (v: BarDrag | null) => {
    barRef.current = v;
    setBar(v);
  };
  // A finger resting on the grid: a tap if it lifts first, a drag if it holds, a scroll if it moves.
  const press = useRef<{ id: number; x: number; y: number; timer: ReturnType<typeof setTimeout>; tap: () => void } | null>(null);
  const dropPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const pr = press.current;
      if (pr && e.pointerId === pr.id && Math.abs(e.clientX - pr.x) + Math.abs(e.clientY - pr.y) > 8) dropPress();
    };
    const up = (e: PointerEvent) => {
      const pr = press.current;
      if (!pr || e.pointerId !== pr.id) return;
      dropPress();
      swallowClick();
      pr.tap();
    };
    const cancel = (e: PointerEvent) => press.current?.id === e.pointerId && dropPress();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      dropPress();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
  }, []);
  const hold = (e: ReactPointerEvent, onHold: () => void, onTap: () => void) => {
    dropPress();
    const timer = setTimeout(() => {
      press.current = null;
      navigator.vibrate?.(8);
      onHold();
    }, HOLD_MS);
    press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, timer, tap: onTap };
  };

  // Open on the working day (or a little before now, today).
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const nowMin = days.includes(p.today) ? minuteOfDay(p.now, tz) : null;
    const target = nowMin !== null && (nowMin < p.prefs.workStart || nowMin > p.prefs.workEnd - 120) ? nowMin - 120 : p.prefs.workStart - 60;
    // A little above the hour, so its label (centred on the line) is not cut under the all-day row.
    el.scrollTop = Math.max(0, target * PX_PER_MIN - 12);
    // Only when the days change, not on every tick of the clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days.join(","), tz]);

  const timed = useMemo(() => piecesOf(p.items.filter((i) => !i.allDay), days, tz), [p.items, days, tz]);
  const byDay = useMemo(() => {
    const m = new Map<string, (Piece & { col: number; span: number; cols: number })[]>();
    for (const d of days) {
      const pieces = timed.filter((x) => x.day === d);
      const placed = new Map(layoutDay(pieces.map((x) => ({ id: x.key, top: x.top, bottom: x.bottom }))).map((x) => [x.id, x]));
      m.set(
        d,
        pieces.map((x) => {
          const pl = placed.get(x.key);
          return { ...x, col: pl?.col ?? 0, span: pl?.span ?? 1, cols: pl?.cols ?? 1 };
        })
      );
    }
    return m;
  }, [timed, days]);
  const bars = useMemo(() => layoutBars(barsOf(p.items, days)), [p.items, days]);
  const barRows = bars.reduce((n, b) => Math.max(n, b.row + 1), 0);

  // ------------------------------------------------------------ timed drags

  const locate = (x: number, y: number): { day: number; minute: number } => {
    // The column under the pointer, else the nearest one (either side: right to left, the first day is on the right).
    let day = -1;
    let best = Infinity;
    for (let i = 0; i < cols.current.length; i++) {
      const r = cols.current[i]?.getBoundingClientRect();
      if (!r) continue;
      if (x >= r.left && x < r.right) {
        day = i;
        break;
      }
      const d = Math.min(Math.abs(x - r.left), Math.abs(x - r.right));
      if (d < best) {
        best = d;
        day = i;
      }
    }
    if (day < 0) day = 0;
    const r = cols.current[day]?.getBoundingClientRect();
    const minute = r ? Math.max(0, Math.min(1440, (y - r.top) / PX_PER_MIN)) : 0;
    return { day, minute };
  };

  const startTimed = (e: ReactPointerEvent, mode: Drag["mode"], dayIdx: number, item?: GridItem) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const { minute } = locate(e.clientX, e.clientY);
    const base: Drag = { mode, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, day0: dayIdx, minute0: minute, moved: false, cur: { day: dayIdx, top: floorTo(minute), bottom: floorTo(minute) + SNAP } };
    if (item) {
      base.item = item;
      base.rel = minuteOfDay(item.start, tz) - 1440 * daysBetween(dayOf(item.start, tz), days[dayIdx]);
      base.dur = Math.max(SNAP, Math.round((item.end - item.start) / 60_000));
      base.cur = mode === "resize" ? { day: dayIdx, top: Math.max(0, base.rel), bottom: base.rel + base.dur } : { day: dayIdx, top: base.rel, bottom: base.rel + base.dur };
    }
    if (e.pointerType === "touch" && mode !== "resize") {
      const tap = () => {
        if (item) return p.onSelect(item);
        const start = atMinute(days[dayIdx], floorTo(minute, 30), tz);
        p.onCreate({ start, end: start + p.prefs.defaultDuration * 60_000 });
      };
      const top = floorTo(minute);
      const lifted: Drag = item ? { ...base, moved: true, touch: true } : { ...base, moved: true, touch: true, cur: { day: dayIdx, top, bottom: Math.min(1440, top + p.prefs.defaultDuration) } };
      hold(e, () => putDrag(lifted), tap);
      return;
    }
    putDrag(base);
  };

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      const far = Math.abs(e.clientX - d.x0) > 3 || Math.abs(e.clientY - d.y0) > 3;
      if (!far && !d.moved) return;
      // Near the edges, the grid scrolls along.
      const sr = scroll.current?.getBoundingClientRect();
      if (sr && scroll.current) {
        if (e.clientY < sr.top + 24) scroll.current.scrollTop -= 12;
        else if (e.clientY > sr.bottom - 24) scroll.current.scrollTop += 12;
      }
      const at = locate(e.clientX, e.clientY);
      let cur = d.cur;
      if (d.mode === "create") {
        const a = floorTo(Math.min(d.minute0, at.minute));
        const b = Math.max(a + SNAP, Math.ceil(Math.max(d.minute0, at.minute) / SNAP) * SNAP);
        cur = { day: d.day0, top: a, bottom: Math.min(1440, b) };
      } else if (d.mode === "resize") {
        cur = { day: d.cur.day, top: d.cur.top, bottom: Math.min(1440, Math.max(d.cur.top + SNAP, snap(at.minute))) };
      } else {
        const top = Math.max(-(d.dur ?? 0) + SNAP, Math.min(1440 - SNAP, (d.rel ?? 0) + snap(at.minute - d.minute0)));
        cur = { day: at.day, top, bottom: top + (d.dur ?? 30) };
      }
      putDrag({ ...d, moved: true, cur });
    };
    // While a finger drags, the grid does not scroll under it.
    const block = (e: TouchEvent) => dragRef.current?.touch && e.cancelable && e.preventDefault();
    const cancel = (e: PointerEvent) => dragRef.current?.pointerId === e.pointerId && putDrag(null);
    const up = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      putDrag(null);
      swallowClick();
      const day = days[d.cur.day];
      if (!d.moved) {
        if (d.mode === "create") {
          const start = atMinute(days[d.day0], floorTo(d.minute0, 30), tz);
          p.onCreate({ start, end: start + p.prefs.defaultDuration * 60_000 });
        } else if (d.item) p.onSelect(d.item);
        return;
      }
      if (d.mode === "create") p.onCreate({ start: atMinute(day, d.cur.top, tz), end: atMinute(day, d.cur.bottom, tz) });
      else if (d.item && d.mode === "resize") {
        const end = atMinute(day, d.cur.bottom, tz);
        if (end !== d.item.end) p.onMove(d.item, { start: d.item.start, end });
      } else if (d.item) {
        // On the wall clock of the column it was dropped on.
        const start = atMinute(day, d.cur.top, tz);
        const end = start + (d.item.end - d.item.start);
        if (start !== d.item.start) p.onMove(d.item, { start, end });
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        putDrag(null);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("touchmove", block, { passive: false });
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("touchmove", block);
      window.removeEventListener("keydown", key, true);
    };
    // The handlers read the latest drag from the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null, days, tz]);

  // ------------------------------------------------------------ all-day drags

  const barDay = (x: number): number => {
    const el = barArea.current;
    const r = el?.getBoundingClientRect();
    if (!el || !r) return 0;
    const i = Math.max(0, Math.min(days.length - 1, Math.floor(((x - r.left) / r.width) * days.length)));
    // Right to left, the first day is on the right.
    return getComputedStyle(el).direction === "rtl" ? days.length - 1 - i : i;
  };
  const startBar = (e: ReactPointerEvent, mode: BarDrag["mode"], item?: GridItem, from?: number, to?: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const d = barDay(e.clientX);
    putBar({ mode, pointerId: e.pointerId, x0: e.clientX, day0: d, item, moved: false, cur: { from: from ?? d, to: to ?? d } });
  };
  useEffect(() => {
    if (!bar) return;
    const move = (e: PointerEvent) => {
      const b = barRef.current;
      if (!b || e.pointerId !== b.pointerId) return;
      if (!b.moved && Math.abs(e.clientX - b.x0) < 4) return;
      const d = barDay(e.clientX);
      if (b.mode === "create") putBar({ ...b, moved: true, cur: { from: Math.min(b.day0, d), to: Math.max(b.day0, d) } });
      else {
        const shift = d - b.day0;
        const len = b.cur.to - b.cur.from;
        const from = (barsOf(b.item ? [b.item] : [], days)[0]?.from ?? b.cur.from) + shift;
        putBar({ ...b, moved: true, cur: { from, to: from + len } });
      }
    };
    const up = (e: PointerEvent) => {
      const b = barRef.current;
      if (!b || e.pointerId !== b.pointerId) return;
      putBar(null);
      swallowClick();
      if (b.mode === "create") {
        p.onCreate({ startDay: days[b.cur.from], endDay: addDays(days[b.cur.to], 1) });
        return;
      }
      if (!b.item) return;
      if (!b.moved) return p.onSelect(b.item);
      const orig = barsOf([b.item], days)[0];
      const shift = b.cur.from - (orig?.from ?? b.cur.from);
      if (!shift) return;
      const dayShift = daysBetween(days[orig.from], days[Math.max(0, Math.min(days.length - 1, b.cur.from))]);
      p.onMove(b.item, { startDay: addDays(b.item.startDay, dayShift), endDay: addDays(b.item.endDay, dayShift) });
    };
    const cancel = (e: PointerEvent) => barRef.current?.pointerId === e.pointerId && putBar(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bar !== null, days]);

  // ------------------------------------------------------------ drawing

  const zones = [p.tz, ...p.zones.filter((z) => z !== p.tz)];
  const nowMinute = minuteOfDay(p.now, tz);
  const work = (d: string) => p.prefs.workDays.includes(new Date(`${d}T12:00:00Z`).getUTCDay());
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const style = { "--cal-days": days.length, "--cal-zones": zones.length } as CSSProperties;

  const evClass = (it: GridItem) => {
    const past = p.prefs.dimPast && it.end <= p.now;
    const declined = it.kind === "event" && it.event.rsvp === "declined";
    const pending = it.kind === "event" && (it.event.rsvp === "needs-action" || it.event.rsvp === "tentative");
    const free = it.kind === "event" && !it.event.busy;
    return `cal-ev${past ? " cal-ev-past" : ""}${declined ? " cal-ev-declined" : ""}${pending ? " cal-ev-pending" : ""}${free ? " cal-ev-free" : ""}${it.kind === "layer" ? ` cal-ev-layer cal-ev-${it.layer.kind}` : ""}${p.selected === it.key ? " cal-ev-sel" : ""}`;
  };
  const colorFor = (it: GridItem) => (it.kind === "event" ? colorOf(it.event, p.cals) : it.layer.color);

  return (
    <div className="cal-grid" style={style}>
      <div className="cal-grid-head">
        <div className="cal-gutter-head">
          {zones.map((z) => (
            <span key={z} className="cal-zone-abbr" title={zoneCity(z)}>
              {zoneAbbr(p.now, z, p.locale === "en" ? "en-US" : undefined)}
            </span>
          ))}
        </div>
        <div className="cal-dayheads">
          {days.map((d) => (
            <button key={d} type="button" className="cal-dayhead" data-today={d === p.today || undefined} data-past={d < p.today || undefined} onClick={() => p.onDay(d)}>
              <span className="cal-dayhead-wd">{weekdayShort(d, p.locale)}</span>
              <span className="cal-dayhead-n">{dayNum(d, p.locale)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="cal-allday">
        <div className="cal-allday-label" title={t("c.allDay")}>
          {t("c.allDay")}
        </div>
        <div ref={barArea} className="cal-allday-area" style={{ minHeight: Math.max(1, barRows) * 24 + 6 }} onPointerDown={(e) => startBar(e, "create")}>
          {bars.map((b) => {
            const moving = bar?.mode === "move" && bar.item?.key === b.item.key && bar.moved;
            const from = moving ? bar!.cur.from : b.from;
            const to = moving ? bar!.cur.to : b.to;
            const it = b.item;
            return (
              <div
                key={b.id}
                className={`${evClass(it)} cal-bar`}
                role="button"
                tabIndex={0}
                aria-label={title(it, t)}
                data-key={it.key}
                style={{ "--ev": colorFor(it), insetInlineStart: `calc(${(Math.max(0, from) / days.length) * 100}% + 2px)`, width: `calc(${((Math.min(days.length - 1, to) - Math.max(0, from) + 1) / days.length) * 100}% - 4px)`, top: b.row * 24 + 3 } as CSSProperties}
                onPointerDown={(e) => (canDrag(it) ? startBar(e, "move", it, b.from, b.to) : (e.stopPropagation(), swallowClick(), p.onSelect(it)))}
                onKeyDown={(e) => e.key === "Enter" && p.onSelect(it)}
              >
                <span className="cal-ev-title">{title(it, t)}</span>
              </div>
            );
          })}
          {bar?.mode === "create" && (
            <div className="cal-ev cal-bar cal-ev-ghost" style={{ insetInlineStart: `calc(${(bar.cur.from / days.length) * 100}% + 2px)`, width: `calc(${((bar.cur.to - bar.cur.from + 1) / days.length) * 100}% - 4px)`, top: 3 }} />
          )}
          {p.overlays.map((o) =>
            o.busy
              .filter((x) => x.allDay)
              .map((x, i) => {
                const fromDay = dayOf(x.start, "UTC");
                const idx = days.indexOf(fromDay);
                return idx < 0 ? null : <div key={`${o.userId}-${i}`} className="cal-busy cal-busy-bar" style={{ "--ev": o.color, left: `${(idx / days.length) * 100}%`, width: `${100 / days.length}%` } as CSSProperties} title={o.name} />;
              })
          )}
        </div>
      </div>
      <div ref={scroll} className="cal-grid-scroll">
        <div className="cal-grid-body" style={{ height: 1440 * PX_PER_MIN }}>
          <div className="cal-gutters">
            {zones.map((z, zi) => (
              <div key={z} className="cal-gutter" data-primary={zi === 0 || undefined}>
                {hours.map((h) => {
                  if (h === 0) return null;
                  // The current time's label takes the place of an hour label it would cover (Notion).
                  if (zi === 0 && days.includes(p.today) && Math.abs(h * 60 - nowMinute) < 15) return null;
                  // The instant of this hour on the first day, read on that zone's clock.
                  const at = atMinute(days[0], h * 60, tz);
                  const label = zi === 0 ? fmtMinute(h * 60, p.locale, p.h12) : fmtTime(at, z, p.locale, p.h12);
                  return (
                    <span key={h} className="cal-hour" style={{ top: h * 60 * PX_PER_MIN }}>
                      {label}
                    </span>
                  );
                })}
                {zi === 0 && days.includes(p.today) && (
                  <span className="cal-now-label" style={{ top: nowMinute * PX_PER_MIN }}>
                    {fmtTime(p.now, tz, p.locale, p.h12, false)}
                  </span>
                )}
              </div>
            ))}
          </div>
          <div className="cal-cols">
            {days.map((d, di) => (
              <div
                key={d}
                ref={(el) => {
                  cols.current[di] = el;
                }}
                className="cal-col"
                data-day={d}
                data-today={d === p.today || undefined}
                onPointerDown={(e) => startTimed(e, "create", di)}
              >
                {work(d) && <div className="cal-work" style={{ top: p.prefs.workStart * PX_PER_MIN, height: (p.prefs.workEnd - p.prefs.workStart) * PX_PER_MIN }} />}
                {p.overlays.map((o) =>
                  o.busy
                    .filter((x) => !x.allDay && x.end > atMinute(d, 0, tz) && x.start < atMinute(addDays(d, 1), 0, tz))
                    .map((x, i) => {
                      const top = x.start <= atMinute(d, 0, tz) ? 0 : minuteOfDay(x.start, tz);
                      const bottom = x.end >= atMinute(addDays(d, 1), 0, tz) ? 1440 : minuteOfDay(x.end, tz);
                      return (
                        <div key={`${o.userId}-${i}`} className="cal-busy" style={{ "--ev": o.color, top: top * PX_PER_MIN, height: Math.max(8, (bottom - top) * PX_PER_MIN) } as CSSProperties} title={x.title ? `${o.name}: ${x.title}` : t("c.busyOf", { name: o.name })}>
                          <span>{x.title ?? o.name}</span>
                        </div>
                      );
                    })
                )}
                {(byDay.get(d) ?? []).map((pc) => {
                  const it = pc.item;
                  const moving = drag && drag.item?.key === it.key && drag.moved && drag.mode !== "create";
                  // A finger's drag keeps the event in the page (its touches stop where their target leaves it).
                  if (moving && drag.mode === "move" && !drag.touch) return null;
                  const bottom = moving && drag.mode === "resize" && pc.last ? Math.min(1440, drag.cur.bottom - 1440 * daysBetween(days[drag.cur.day], d)) : pc.bottom;
                  const h = Math.max(14, (bottom - pc.top) * PX_PER_MIN - 2);
                  const short = h < 34;
                  const width = `calc(${(pc.span / pc.cols) * 100}% - ${pc.cols > 1 ? 3 : 6}px)`;
                  const left = `calc(${(pc.col / pc.cols) * 100}% + 1px)`;
                  const ev = it.kind === "event" ? it.event : null;
                  return (
                    <div
                      key={pc.key}
                      className={`${evClass(it)}${short ? " cal-ev-short" : ""}${moving && drag.mode === "move" ? " cal-ev-dragging" : ""}`}
                      role="button"
                      tabIndex={0}
                      data-key={it.key}
                      aria-label={`${title(it, t)}, ${fmtTime(it.start, tz, p.locale, p.h12, false)}`}
                      style={{ "--ev": colorFor(it), top: pc.top * PX_PER_MIN + 1, height: h, insetInlineStart: left, width, zIndex: 2 + pc.col } as CSSProperties}
                      onPointerDown={(e) => (canDrag(it) ? startTimed(e, "move", di, it) : (e.stopPropagation(), swallowClick(), p.onSelect(it)))}
                      onKeyDown={(e) => e.key === "Enter" && p.onSelect(it)}
                    >
                      <span className="cal-ev-title">
                        {title(it, t)}
                        {short && <span className="cal-ev-time">{`, ${fmtTime(it.start, tz, p.locale, p.h12)}`}</span>}
                      </span>
                      {!short && (
                        <span className="cal-ev-time">
                          {fmtTime(it.start, tz, p.locale, p.h12)} – {fmtTime(it.end, tz, p.locale, p.h12)}
                          {ev?.recurring && <Repeat size={10} aria-hidden />}
                          {ev && ev.guests > 0 && <Users size={10} aria-hidden />}
                          {ev?.conference && <Video size={10} aria-hidden />}
                        </span>
                      )}
                      {!short && ev?.location && h > 50 && <span className="cal-ev-where">{ev.location}</span>}
                      {canDrag(it) && pc.last && <span className="cal-ev-resize" onPointerDown={(e) => startTimed(e, "resize", di, it)} aria-hidden />}
                    </div>
                  );
                })}
                {drag?.moved && drag.cur.day === di && (
                  <div
                    className={`cal-ev cal-ev-ghost${drag.mode === "create" ? "" : " cal-ev-moving"}`}
                    style={{ "--ev": drag.item ? colorFor(drag.item) : undefined, top: Math.max(0, drag.cur.top) * PX_PER_MIN + 1, height: Math.max(14, (Math.min(1440, drag.cur.bottom) - Math.max(0, drag.cur.top)) * PX_PER_MIN - 2), insetInlineStart: 1, width: "calc(100% - 6px)" } as CSSProperties}
                  >
                    {drag.item && <span className="cal-ev-title">{title(drag.item, t)}</span>}
                    <span className="cal-ev-time">
                      {fmtMinute(Math.max(0, drag.cur.top), p.locale, p.h12)} – {fmtMinute(Math.min(1440, drag.cur.bottom) % 1440, p.locale, p.h12)}
                    </span>
                  </div>
                )}
                {d === p.today && (
                  <div className="cal-now" style={{ top: nowMinute * PX_PER_MIN }} aria-hidden>
                    <span />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
