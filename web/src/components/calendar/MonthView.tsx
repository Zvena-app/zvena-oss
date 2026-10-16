"use client";

// The month view: six (or five) weeks; all-day and multi-day events as bars
// across their days, timed ones as lines with their time. Drag an event to
// another day; click an empty day to add an all-day event there; "+N more"
// lists the rest. On a phone, a tap on a day opens it.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { layoutBars } from "@/lib/calendar/layout";
import { addDays, daysBetween, offsetOf, parseDay } from "@/lib/calendar/tz";
import type { CalendarInfo, Prefs } from "@/lib/calendar/types";
import { dayNum, fmtDate, fmtDay, fmtTime, weekdayShort } from "./format";
import type { CT } from "./i18n";
import { barsOf, colorOf, type GridItem } from "./model";
import { canDrag, type MoveTarget } from "./TimeGrid";
import { useCal } from "./context";
import { Popover, swallowClick } from "./ui";

const ROW_H = 20;

export interface MonthProps {
  days: readonly string[];
  anchor: string;
  tz: string;
  locale: string;
  h12: boolean;
  items: readonly GridItem[];
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
  pointerId: number;
  x0: number;
  y0: number;
  item: GridItem;
  fromDay: string;
  overDay: string;
  moved: boolean;
}

export function MonthView(p: MonthProps) {
  const { days, t } = p;
  // On a phone a day's box is too small to aim in: a tap opens that day (Google Calendar).
  const { narrow } = useCal();
  const weeks = useMemo(() => Array.from({ length: days.length / 7 }, (_, i) => days.slice(i * 7, i * 7 + 7)), [days]);
  const [cellH, setCellH] = useState(110);
  const body = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState<{ day: string; anchor: HTMLElement } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const putDrag = (v: Drag | null) => {
    dragRef.current = v;
    setDrag(v);
  };
  const month = parseDay(p.anchor).m;

  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCellH(el.clientHeight / Math.max(1, weeks.length)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [weeks.length]);
  const fits = Math.max(1, Math.floor((cellH - 26) / ROW_H));

  // Every item as a bar over day indexes of its week (timed ones take one day).
  const perWeek = useMemo(
    () =>
      weeks.map((w) => {
        const asDays = p.items.map((it) => (it.allDay ? it : { ...it, allDay: true, endDay: addDays(it.startDay, 1) }));
        return layoutBars(barsOf(asDays as GridItem[], w)).map((b) => ({ ...b, item: p.items.find((x) => x.key === b.item.key) as GridItem }));
      }),
    [weeks, p.items]
  );

  const dayAt = (x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    return el?.closest<HTMLElement>("[data-mday]")?.dataset.mday ?? null;
  };
  const start = (e: ReactPointerEvent, item: GridItem, day: string) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    if (!canDrag(item)) return (swallowClick(), p.onSelect(item));
    putDrag({ pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, item, fromDay: day, overDay: day, moved: false });
  };
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      if (!d.moved && Math.abs(e.clientX - d.x0) + Math.abs(e.clientY - d.y0) < 5) return;
      const over = dayAt(e.clientX, e.clientY) ?? d.overDay;
      putDrag({ ...d, moved: true, overDay: over });
    };
    const up = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      putDrag(null);
      swallowClick();
      if (!d.moved) return p.onSelect(d.item);
      const shift = daysBetween(d.fromDay, d.overDay);
      if (!shift) return;
      const it = d.item;
      if (it.allDay) p.onMove(it, { startDay: addDays(it.startDay, shift), endDay: addDays(it.endDay, shift) });
      else {
        // Whole days on the wall clock (a daylight-saving change in between keeps 9:00 at 9:00).
        const fix = (offsetOf(it.start, p.tz) - offsetOf(it.start + shift * 86_400_000, p.tz)) * 60_000;
        p.onMove(it, { start: it.start + shift * 86_400_000 + fix, end: it.end + shift * 86_400_000 + fix });
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null]);

  const color = (it: GridItem) => (it.kind === "event" ? colorOf(it.event, p.cals) : it.layer.color);
  const label = (it: GridItem) => (it.kind === "event" ? it.event.title : it.layer.title) || t("ev.untitled");

  return (
    <div className="cal-month">
      <div className="cal-month-head">
        {weeks[0]?.map((d) => (
          <span key={d}>{weekdayShort(d, p.locale)}</span>
        ))}
      </div>
      <div ref={body} className="cal-month-body" style={{ gridTemplateRows: `repeat(${weeks.length}, 1fr)` }}>
        {weeks.map((w, wi) => {
          const bars = perWeek[wi];
          // The last row shows a bar only where nothing else would hide behind "+N more".
          const shown = bars.filter((b) => b.row < fits - 1 || (b.row === fits - 1 && !bars.some((o) => o !== b && o.row > fits - 1 && o.from <= b.to && o.to >= b.from)));
          const hidden = new Map<string, number>();
          for (const b of bars) if (!shown.includes(b)) for (let i = b.from; i <= b.to; i++) hidden.set(w[i], (hidden.get(w[i]) ?? 0) + 1);
          return (
            <div key={w[0]} className="cal-month-week">
              {w.map((d) => (
                <div
                  key={d}
                  className="cal-month-day"
                  data-mday={d}
                  data-out={parseDay(d).m !== month || undefined}
                  data-today={d === p.today || undefined}
                  data-over={(drag?.moved && drag.overDay === d) || undefined}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest(".cal-ev, .cal-month-more, .cal-month-num")) return;
                    if (narrow) return p.onDay(d);
                    p.onCreate({ startDay: d, endDay: addDays(d, 1) });
                  }}
                >
                  <button type="button" className="cal-month-num" onClick={() => p.onDay(d)} aria-label={fmtDate(d, p.locale)}>
                    {parseDay(d).d === 1 ? fmtDay(d, p.locale, { month: "short", day: "numeric" }) : dayNum(d, p.locale)}
                  </button>
                  {(hidden.get(d) ?? 0) > 0 && (
                    <button type="button" className="cal-month-more" style={{ top: 22 + (fits - 1) * ROW_H }} onClick={(e) => setMore({ day: d, anchor: e.currentTarget })}>
                      {t("c.more", { n: hidden.get(d) ?? 0 })}
                    </button>
                  )}
                </div>
              ))}
              <div className="cal-month-bars">
                {shown.map((b) => {
                    const it = b.item;
                    const timed = !it.allDay;
                    const declined = it.kind === "event" && it.event.rsvp === "declined";
                    return (
                      <div
                        key={b.id}
                        role="button"
                        tabIndex={0}
                        data-key={it.key}
                        className={`cal-ev ${timed ? "cal-mline" : "cal-bar"}${p.prefs.dimPast && it.end <= p.now ? " cal-ev-past" : ""}${declined ? " cal-ev-declined" : ""}${p.selected === it.key ? " cal-ev-sel" : ""}${it.kind === "layer" ? " cal-ev-layer" : ""}${drag?.moved && drag.item.key === it.key ? " cal-ev-dragging" : ""}`}
                        style={{ "--ev": color(it), insetInlineStart: `calc(${(b.from / 7) * 100}% + 2px)`, width: `calc(${((b.to - b.from + 1) / 7) * 100}% - 4px)`, top: 22 + b.row * ROW_H } as CSSProperties}
                        onPointerDown={(e) => start(e, it, w[b.from])}
                        onKeyDown={(e) => e.key === "Enter" && p.onSelect(it)}
                      >
                        {timed && <span className="cal-mline-dot" />}
                        {timed && <span className="cal-ev-time">{fmtTime(it.start, p.tz, p.locale, p.h12)}</span>}
                        <span className="cal-ev-title">{label(it)}</span>
                      </div>
                    );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {more && (
        <Popover anchor={more.anchor} onClose={() => setMore(null)} width={260} label={fmtDate(more.day, p.locale)}>
          <div className="cal-more-pop">
            <div className="cal-more-title">{fmtDate(more.day, p.locale)}</div>
            {p.items
              .filter((it) => it.startDay <= more.day && (it.allDay ? it.endDay > more.day : it.startDay === more.day || it.endDay >= more.day))
              .map((it) => (
                <button
                  key={it.key}
                  type="button"
                  className={`cal-ev ${it.allDay ? "cal-bar" : "cal-mline"}`}
                  style={{ "--ev": color(it) } as CSSProperties}
                  onClick={() => {
                    setMore(null);
                    p.onSelect(it);
                  }}
                >
                  {!it.allDay && <span className="cal-mline-dot" />}
                  {!it.allDay && <span className="cal-ev-time">{fmtTime(it.start, p.tz, p.locale, p.h12)}</span>}
                  <span className="cal-ev-title">{label(it)}</span>
                </button>
              ))}
          </div>
        </Popover>
      )}
    </div>
  );
}
