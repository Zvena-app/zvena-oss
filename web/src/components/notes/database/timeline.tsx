"use client";

// Timeline view (Notion's Gantt-style layout): rows as bars over a time
// scale. Drag a bar to move it, drag its edges to change the dates, click an
// empty track to give a row dates.

import { upperFirst } from "./cells";
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, FileText, Plus } from "lucide-react";
import { Menu, Popover } from "../ui";
import type { DbCtl } from "./useDatabase";
import { displayTitle } from "@/lib/notes/model";
import type { DateValue, Note, TimelineZoom } from "@/lib/notes/types";
import type { NotesKey } from "@/lib/notes/i18n";
import { NoteIcon } from "../NoteIcon";
import { intlOf } from "@/i18n/locales";

const DAY = 86_400_000;
/** Pixels per day for each scale. */
const PX: Record<TimelineZoom, number> = { week: 72, month: 32, quarter: 8, year: 2.4 };
const ZOOMS: TimelineZoom[] = ["week", "month", "quarter", "year"];
const ROW_H = 36;

/** Day number (UTC-based, so DST never shifts a day). */
const dayOf = (iso: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY) : null;
};
const isoOf = (day: number): string => new Date(day * DAY).toISOString().slice(0, 10);
const todayDay = (): number => {
  const d = new Date();
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
};
const monthStart = (day: number): number => {
  const d = new Date(day * DAY);
  return Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / DAY);
};
const addMonths = (day: number, n: number): number => {
  const d = new Date(day * DAY);
  return Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1) / DAY);
};

interface Span {
  start: number;
  end: number;
}

function spanOf(v: unknown): Span | null {
  const d = v as DateValue | null | undefined;
  if (!d || typeof d !== "object" || typeof d.start !== "string") return null;
  const s = dayOf(d.start);
  if (s === null) return null;
  const e = d.end ? dayOf(d.end) : null;
  return { start: s, end: e !== null && e >= s ? e : s };
}

const NARROW = "(max-width: 639px)";
const subscribeNarrow = (cb: () => void) => {
  const m = window.matchMedia(NARROW);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
/** Phone-width screens get a narrower title column. */
function useNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, () => window.matchMedia(NARROW).matches, () => false);
}

type Drag = { id: string; mode: "move" | "start" | "end"; x0: number; orig: Span; cur: Span; moved: boolean };

export function TimelineView({ ctl }: { ctl: DbCtl }) {
  const { t, locale } = ctl.api;
  const view = ctl.view;
  const dateProp = ctl.schema?.properties.find((p) => p.id === view?.dateProp && p.type === "date") ?? ctl.schema?.properties.find((p) => p.type === "date");
  // Notion's "Use separate start and end dates": the bar ends on another date property.
  const endProp = ctl.schema?.properties.find((p) => p.id === view?.endProp && p.type === "date" && p.id !== dateProp?.id);
  const valueOf = (r: Note): unknown => {
    const v = r.props?.[dateProp?.id ?? ""] as DateValue | undefined;
    if (!endProp || !v?.start) return v;
    const e = r.props?.[endProp.id] as DateValue | undefined;
    return { start: v.start, ...(e?.start ? { end: e.start } : {}) };
  };
  // Read-only members zoom for themselves (the view setting is shared).
  const [ownZoom, setOwnZoom] = useState<TimelineZoom | null>(null);
  const zoom: TimelineZoom = ownZoom ?? view?.zoom ?? "month";
  const ro = ctl.readOnly;
  const px = PX[zoom];
  const showTable = !view?.hideTable;
  // The title column (narrower on phones); CSS reads it as --tl-left.
  const narrow = useNarrow();
  const leftW = showTable ? (narrow ? 150 : 260) : 0;
  const loc = intlOf(locale);
  const scroller = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [zoomMenu, setZoomMenu] = useState<HTMLElement | null>(null);
  const [hover, setHover] = useState<{ id: string; day: number } | null>(null);
  // Dependencies: a line being drawn from a bar's dot, and the arrow picked for removal.
  const [link, setLink] = useState<{ from: string; x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [pickedDep, setPickedDep] = useState<{ from: string; to: string; el: HTMLElement } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const deps = ctl.schema?.deps;
  const blockedByProp = deps ? ctl.schema?.properties.find((p) => p.id === deps.blockedBy) : undefined;
  const today = todayDay();

  const spans = useMemo(() => {
    const map = new Map<string, Span>();
    if (!dateProp) return map;
    for (const r of ctl.rows) {
      const s = spanOf(valueOf(r));
      if (s) map.set(r.id, s);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctl.rows, dateProp, endProp]);

  // The visible range: whole months around the rows and today, with room to plan ahead.
  const range = useMemo(() => {
    let lo = today;
    let hi = today;
    for (const s of spans.values()) {
      lo = Math.min(lo, s.start);
      hi = Math.max(hi, s.end);
    }
    const pad = zoom === "year" ? 12 : zoom === "quarter" ? 4 : 2;
    const from = addMonths(monthStart(lo), -Math.ceil(pad / 2));
    const to = addMonths(monthStart(hi), pad + 1);
    return { from, days: to - from };
  }, [spans, today, zoom]);
  const width = range.days * px;
  const x = (day: number) => (day - range.from) * px;

  // Open on today (a third from the left), and again after a zoom change.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = Math.max(0, x(today) - (el.clientWidth - leftW) / 3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, dateProp?.id]);

  // Header: months on top; days, week starts or nothing underneath.
  const months = useMemo(() => {
    const out: { day: number; len: number; label: string }[] = [];
    let d = range.from;
    while (d < range.from + range.days) {
      const next = addMonths(d, 1);
      const date = new Date(d * DAY);
      const label = date.toLocaleDateString(loc, { month: zoom === "year" ? "short" : "long", ...(zoom === "year" && date.getUTCMonth() !== 0 ? {} : { year: "numeric" }), timeZone: "UTC" });
      out.push({ day: d, len: next - d, label });
      d = next;
    }
    return out;
  }, [range, loc, zoom]);
  const ticks = useMemo(() => {
    const out: { day: number; label: string; weekend: boolean }[] = [];
    if (zoom === "year") return out;
    for (let d = range.from; d < range.from + range.days; d++) {
      const date = new Date(d * DAY);
      const dow = date.getUTCDay();
      const weekend = dow === 0 || dow === 6;
      if (zoom === "quarter" && dow !== 1) continue;
      out.push({ day: d, label: String(date.getUTCDate()), weekend });
    }
    return out;
  }, [range, zoom]);

  if (!dateProp) return <div className="nt-panel-empty" style={{ textAlign: "left", padding: "24px 4px" }}>{t("db.noDateProp")}</div>;

  const save = (row: Note, s: Span) => {
    const raw = ctl.api.snap.byId.get(row.id);
    const cur = raw?.props?.[dateProp.id] as DateValue | undefined;
    if (endProp) {
      // Two properties: the start on one, the end on the other (times of day and reminders kept).
      const curEnd = raw?.props?.[endProp.id] as DateValue | undefined;
      ctl.setValue(raw ?? row, dateProp, { start: cur?.start ? isoOf(s.start) + cur.start.slice(10) : isoOf(s.start), ...(cur?.remind ? { remind: cur.remind } : {}) });
      ctl.setValue(ctl.api.store.get(row.id) ?? raw ?? row, endProp, { start: curEnd?.start ? isoOf(s.end) + curEnd.start.slice(10) : isoOf(s.end), ...(curEnd?.remind ? { remind: curEnd.remind } : {}) });
      return;
    }
    // Keep any time of day the dates had, and the reminder.
    const start = cur?.start ? isoOf(s.start) + cur.start.slice(10) : isoOf(s.start);
    const end = s.end > s.start ? (cur?.end ? isoOf(s.end) + cur.end.slice(10) : isoOf(s.end)) : undefined;
    ctl.setValue(raw ?? row, dateProp, { start, ...(end ? { end } : {}), ...(cur?.remind ? { remind: cur.remind } : {}) });
  };

  const onBarDown = (e: ReactPointerEvent<HTMLDivElement>, row: Note, s: Span) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const off = e.clientX - r.left;
    const edge = Math.min(8, r.width / 3);
    const mode: Drag["mode"] = off < edge ? "start" : off > r.width - edge ? "end" : "move";
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id: row.id, mode, x0: e.clientX, orig: s, cur: s, moved: false });
  };
  const onBarMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Read-only: a press only opens the row.
    if (!drag || ro) return;
    const dd = Math.round((e.clientX - drag.x0) / px);
    const o = drag.orig;
    let cur: Span = o;
    if (drag.mode === "move") cur = { start: o.start + dd, end: o.end + dd };
    else if (drag.mode === "start") cur = { start: Math.min(o.start + dd, o.end), end: o.end };
    else cur = { start: o.start, end: Math.max(o.end + dd, o.start) };
    const moved = drag.moved || Math.abs(e.clientX - drag.x0) > 3;
    if (cur.start !== drag.cur.start || cur.end !== drag.cur.end || moved !== drag.moved) setDrag({ ...drag, cur, moved });
  };
  /** Items waiting for `id` that now start too early move after it (Notion: "shift when dates overlap"). */
  const shiftDependents = (id: string, end: number, seen: Set<string>) => {
    if (!blockedByProp) return;
    for (const r of ctl.rows) {
      if (seen.has(r.id)) continue;
      const fresh = ctl.api.store.get(r.id) ?? r;
      const ids = fresh.props?.[blockedByProp.id];
      if (!Array.isArray(ids) || !ids.includes(id)) continue;
      const s = spanOf(valueOf(fresh));
      if (!s || s.start > end) continue;
      const dd = end + 1 - s.start;
      const next = { start: s.start + dd, end: s.end + dd };
      seen.add(r.id);
      save(fresh, next);
      shiftDependents(r.id, next.end, seen);
    }
  };
  const onBarUp = (row: Note) => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (!d.moved) {
      ctl.openRow(row.id);
      return;
    }
    if (d.cur.start !== d.orig.start || d.cur.end !== d.orig.end) {
      save(row, d.cur);
      if (d.cur.end > d.orig.end) shiftDependents(row.id, d.cur.end, new Set([row.id]));
    }
  };

  // Rows' vertical centres (arrows run from a blocker's end to the waiting item's start).
  const rowY = new Map(ctl.rows.map((r, i) => [r.id, i * ROW_H + ROW_H / 2]));
  const spanNow = (id: string) => (drag?.id === id ? drag.cur : spans.get(id));
  const barRight = (s: Span) => x(s.start) + Math.max(px, (s.end - s.start + 1) * px);
  const arrows: { from: string; to: string; d: string; late: boolean }[] = [];
  if (blockedByProp) {
    for (const r of ctl.rows) {
      const to = spanNow(r.id);
      const ids = r.props?.[blockedByProp.id];
      if (!to || !Array.isArray(ids)) continue;
      for (const from of ids) {
        const fs = spanNow(from);
        const y1 = rowY.get(from);
        const y2 = rowY.get(r.id);
        if (!fs || y1 === undefined || y2 === undefined || from === r.id) continue;
        const x1 = barRight(fs);
        const x2 = x(to.start);
        const bend = Math.max(24, Math.abs(x2 - x1) / 2);
        arrows.push({ from, to: r.id, late: fs.end >= to.start, d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2 - 2} ${y2}` });
      }
    }
  }
  const startLink = (e: ReactPointerEvent<HTMLSpanElement>, row: Note, s: Span) => {
    e.preventDefault();
    e.stopPropagation();
    const box = svgRef.current?.getBoundingClientRect();
    const y = rowY.get(row.id);
    if (!box || y === undefined) return;
    const x1 = barRight(s);
    setLink({ from: row.id, x1, y1: y, x2: e.clientX - box.left, y2: e.clientY - box.top });
    const move = (ev: PointerEvent) => setLink((l) => (l ? { ...l, x2: ev.clientX - box.left, y2: ev.clientY - box.top } : l));
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setLink(null);
      const target = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-row]")?.dataset.row;
      if (!target || target === row.id || !blockedByProp) return;
      const t2 = ctl.api.store.get(target);
      if (!t2) return;
      const cur = Array.isArray(t2.props?.[blockedByProp.id]) ? (t2.props?.[blockedByProp.id] as string[]) : [];
      if (!cur.includes(row.id)) ctl.setValue(t2, blockedByProp, [...cur, row.id]);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const dayAt = (e: ReactPointerEvent<HTMLDivElement> | React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return range.from + Math.floor((e.clientX - r.left) / px);
  };
  const scrollBy = (dir: number) => scroller.current?.scrollBy({ left: dir * (scroller.current.clientWidth - 300) * 0.8, behavior: "smooth" });
  const toToday = () => {
    const el = scroller.current;
    if (el) el.scrollTo({ left: Math.max(0, x(today) - (el.clientWidth - leftW) / 3), behavior: "smooth" });
  };
  const fmtRange = (s: Span) => {
    const f = (d: number) => new Date(d * DAY).toLocaleDateString(loc, { month: "short", day: "numeric", timeZone: "UTC" });
    return s.end > s.start ? `${f(s.start)} → ${f(s.end)}` : f(s.start);
  };

  return (
    <div className="nt-tl" data-zoom={zoom} style={{ ["--tl-left" as string]: `${leftW}px` }}>
      <div className="nt-tl-bar">
        <button type="button" className="nt-db-tool nt-btn-reset" onClick={(e) => setZoomMenu(e.currentTarget)}>
          {t(`db.zoom.${zoom}` as NotesKey)}
          <ChevronDown size={12} />
        </button>
        <span style={{ flex: 1 }} />
        <button type="button" className="nt-db-tool nt-btn-reset" onClick={toToday}>
          {t("db.today")}
        </button>
        <button type="button" className="nt-db-tool nt-btn-reset" aria-label={t("db.prev")} onClick={() => scrollBy(-1)}>
          <ChevronLeft />
        </button>
        <button type="button" className="nt-db-tool nt-btn-reset" aria-label={t("db.next")} onClick={() => scrollBy(1)}>
          <ChevronRight />
        </button>
      </div>
      <div className="nt-tl-scroll" ref={scroller}>
        <div className="nt-tl-inner" style={{ width: width + leftW }}>
          <div className="nt-tl-head">
            {showTable && <div className="nt-tl-left nt-tl-left-head">{ctl.schema?.properties.find((p) => p.type === "title")?.name}</div>}
            <div className="nt-tl-scale" style={{ width }}>
              <div className="nt-tl-months">
                {months.map((m) => (
                  <div key={m.day} className="nt-tl-month" style={{ left: x(m.day), width: m.len * px }}>
                    <span>{upperFirst(m.label)}</span>
                  </div>
                ))}
              </div>
              {ticks.length > 0 && (
                <div className="nt-tl-days">
                  {ticks.map((d) => (
                    <div key={d.day} className="nt-tl-day" data-today={d.day === today || undefined} data-weekend={(d.weekend && zoom !== "quarter") || undefined} style={{ left: x(d.day), width: zoom === "quarter" ? 7 * px : px }}>
                      {d.label}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="nt-tl-body">
            <div className="nt-tl-grid" style={{ left: leftW, width }}>
              {zoom !== "quarter" && zoom !== "year" && ticks.filter((d) => d.weekend).map((d) => <div key={d.day} className="nt-tl-weekend" style={{ left: x(d.day), width: px }} />)}
              {(zoom === "quarter" || zoom === "year") && months.map((m) => <div key={m.day} className="nt-tl-mline" style={{ left: x(m.day) }} />)}
              <div className="nt-tl-today" style={{ left: x(today) + px / 2 }} />
            </div>
            {blockedByProp && (
              <svg ref={svgRef} className="nt-tl-deps" style={{ left: leftW, width, height: ctl.rows.length * ROW_H }} aria-hidden="true">
                <defs>
                  <marker id="nt-tl-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                    <path d="M0 0 L8 4 L0 8 z" fill="context-stroke" />
                  </marker>
                </defs>
                {arrows.map((a) => (
                  <path
                    key={`${a.from}>${a.to}`}
                    d={a.d}
                    className="nt-tl-dep"
                    data-late={a.late || undefined}
                    markerEnd="url(#nt-tl-arrow)"
                    onClick={(e) => !ro && setPickedDep({ from: a.from, to: a.to, el: e.currentTarget as unknown as HTMLElement })}
                  />
                ))}
                {link && <path d={`M ${link.x1} ${link.y1} L ${link.x2} ${link.y2}`} className="nt-tl-dep nt-tl-dep-draft" markerEnd="url(#nt-tl-arrow)" />}
              </svg>
            )}
            {ctl.rows.map((row) => {
              const base = spans.get(row.id) ?? null;
              const s = drag?.id === row.id ? drag.cur : base;
              const title = displayTitle(row, t("db.untitled"));
              return (
                <div key={row.id} className="nt-tl-row" style={{ height: ROW_H }}>
                  {showTable && (
                    <div className="nt-tl-left" onClick={() => ctl.openRow(row.id)}>
                      <span className="nt-tl-left-icon"><NoteIcon icon={row.icon} fallback={<FileText size={14} />} /></span>
                      <span className="nt-tl-left-title">{title}</span>
                    </div>
                  )}
                  <div
                    className="nt-tl-track"
                    style={{ width }}
                    data-empty={!s || undefined}
                    title={!s ? t("db.setDate") : undefined}
                    onMouseMove={(e) => !s && !ro && setHover({ id: row.id, day: dayAt(e) })}
                    onMouseLeave={() => hover?.id === row.id && setHover(null)}
                    onClick={(e) => {
                      if (s || ro) return;
                      const day = dayAt(e);
                      const len = zoom === "week" || zoom === "month" ? 0 : 6;
                      save(row, { start: day, end: day + len });
                      setHover(null);
                    }}
                  >
                    {!s && hover?.id === row.id && <div className="nt-tl-ghost" style={{ left: x(hover.day), width: Math.max(px, zoom === "week" || zoom === "month" ? px : 7 * px) }} />}
                    {s && (s.end - s.start + 1) * px < 90 && (
                      // Too short for its title: the title sits to the right (Notion).
                      <span className="nt-tl-item-out" style={{ left: x(s.start) + Math.max(px, (s.end - s.start + 1) * px) + 6 }}>
                        {row.icon && <span><NoteIcon icon={row.icon} /> </span>}
                        {title}
                      </span>
                    )}
                    {s && (
                      <div
                        className="nt-tl-item"
                        data-row={row.id}
                        data-short={(s.end - s.start + 1) * px < 90 || undefined}
                        data-dragging={drag?.id === row.id || undefined}
                        style={{ left: x(s.start), width: Math.max(px, (s.end - s.start + 1) * px) }}
                        onPointerDown={(e) => onBarDown(e, row, s)}
                        onPointerMove={onBarMove}
                        onPointerUp={() => onBarUp(row)}
                        onPointerCancel={() => setDrag(null)}
                        title={`${title} · ${fmtRange(s)}`}
                      >
                        <span className="nt-tl-grip nt-tl-grip-l" />
                        {row.icon && <span className="nt-tl-item-icon"><NoteIcon icon={row.icon} /></span>}
                        <span className="nt-tl-item-title">{title}</span>
                        {drag?.id === row.id && drag.moved && <span className="nt-tl-item-dates">{fmtRange(s)}</span>}
                        <span className="nt-tl-grip nt-tl-grip-r" />
                        {blockedByProp && !ro && <span className="nt-tl-dot" title={t("db.depHint")} onPointerDown={(e) => startLink(e, row, s)} />}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {!ro && (
              <div className="nt-tl-row nt-tl-new" style={{ height: ROW_H }}>
                <button
                  type="button"
                  className="nt-tl-left nt-btn-reset"
                  onClick={() => {
                    ctl.addRow({ props: { [dateProp.id]: { start: isoOf(today) } } });
                  }}
                >
                  <Plus size={14} />
                  {t("db.newRow")}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      {pickedDep && blockedByProp && (
        <Popover anchor={pickedDep.el} onClose={() => setPickedDep(null)}>
          <Menu
            width={220}
            groups={[
              {
                key: "d",
                items: [
                  {
                    key: "rm",
                    label: t("db.depRemove"),
                    danger: true,
                    onSelect: () => {
                      const r = ctl.api.store.get(pickedDep.to);
                      const cur = Array.isArray(r?.props?.[blockedByProp.id]) ? (r?.props?.[blockedByProp.id] as string[]) : [];
                      if (r) ctl.setValue(r, blockedByProp, cur.filter((x) => x !== pickedDep.from));
                      setPickedDep(null);
                    },
                  },
                ],
              },
            ]}
          />
        </Popover>
      )}
      {zoomMenu && (
        <Popover anchor={zoomMenu} onClose={() => setZoomMenu(null)}>
          <Menu
            width={180}
            onClose={() => setZoomMenu(null)}
            groups={[
              { key: "z", items: ZOOMS.map((z) => ({ key: z, label: t(`db.zoom.${z}` as NotesKey), checked: z === zoom, onSelect: () => (ro ? setOwnZoom(z) : ctl.updateView({ zoom: z }), setZoomMenu(null)) })) },
              ...(ro
                ? []
                : [
                    {
                      key: "t",
                      items: [
                        { key: "table", label: t("db.timelineTable"), toggle: true, checked: showTable, onSelect: () => ctl.updateView({ hideTable: showTable ? true : undefined }) },
                        { key: "deps", label: t("db.deps"), toggle: true, checked: !!deps, onSelect: () => ctl.setDeps(!deps) },
                      ],
                    },
                  ]),
            ]}
          />
        </Popover>
      )}
    </div>
  );
}
