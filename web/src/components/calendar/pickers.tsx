"use client";

// Pickers of the event panel and the rail: the mini month, a day typed in
// plain words or picked, a time (typed "3pm" or picked every 15 minutes, with
// the length shown from the start), and a time zone found by city.

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Globe } from "lucide-react";
import { parseTimeInput } from "@/lib/notes/dates";
import { parseJump } from "@/lib/calendar/natural";
import { addDays, addMonths, allZones, offsetLabel, parseDay, startOfMonth, startOfWeek, zoneCity } from "@/lib/calendar/tz";
import { dayNum, fmtDate, fmtDay, fmtDuration, fmtMinute } from "./format";
import type { CT } from "./i18n";
import { Popover } from "./ui";

export function MiniMonth({ month, onMonth, selected, today, onPick, weekStart, locale, marks, t }: {
  month: string;
  onMonth: (day: string) => void;
  selected: ReadonlySet<string>;
  today: string;
  onPick: (day: string) => void;
  weekStart: number;
  locale: string;
  marks?: ReadonlySet<string>;
  t: CT;
}) {
  const first = startOfMonth(month);
  const start = startOfWeek(first, weekStart);
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const m = parseDay(first).m;
  return (
    <div className="cal-mini" role="group" aria-label={fmtDay(first, locale, { month: "long", year: "numeric" })}>
      <div className="cal-mini-head">
        <span className="cal-mini-title">{fmtDay(first, locale, { month: "long", year: "numeric" })}</span>
        <button type="button" className="cal-icon-btn" aria-label={t("book.prevMonth")} onClick={() => onMonth(addMonths(first, -1))}>
          <ChevronLeft size={14} />
        </button>
        <button type="button" className="cal-icon-btn" aria-label={t("book.nextMonth")} onClick={() => onMonth(addMonths(first, 1))}>
          <ChevronRight size={14} />
        </button>
      </div>
      <div className="cal-mini-grid">
        {days.slice(0, 7).map((d) => (
          <span key={`h${d}`} className="cal-mini-wd" aria-hidden>
            {fmtDay(d, locale, { weekday: "narrow" })}
          </span>
        ))}
        {days.map((d) => (
          <button
            key={d}
            type="button"
            className="cal-mini-day"
            data-out={parseDay(d).m !== m || undefined}
            data-today={d === today || undefined}
            data-sel={selected.has(d) || undefined}
            data-mark={marks?.has(d) || undefined}
            aria-label={fmtDate(d, locale)}
            aria-pressed={selected.has(d)}
            onClick={() => onPick(d)}
          >
            {dayNum(d, locale)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function DateField({ value, onChange, locale, tz, now, weekStart, t, disabled, label }: { value: string; onChange: (d: string) => void; locale: string; tz: string; now: number; weekStart: number; t: CT; disabled?: boolean; label: string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [text, setText] = useState("");
  const [month, setMonth] = useState(value);
  return (
    <>
      <button
        type="button"
        className="cal-field-btn"
        disabled={disabled}
        aria-label={label}
        onClick={(e) => {
          setMonth(value);
          setText("");
          setAnchor(e.currentTarget);
        }}
      >
        {fmtDate(value, locale)}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={264} label={label}>
          <input
            className="cal-input"
            data-autofocus
            autoFocus
            value={text}
            placeholder={t("nav.gotoHint")}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const d = parseJump(text, locale, now, tz);
              if (d) {
                onChange(d);
                setAnchor(null);
              }
            }}
          />
          <MiniMonth
            month={month}
            onMonth={setMonth}
            selected={new Set([value])}
            today={parseJump("today", "en", now, tz) ?? value}
            weekStart={weekStart}
            locale={locale}
            t={t}
            onPick={(d) => {
              onChange(d);
              setAnchor(null);
            }}
          />
        </Popover>
      )}
    </>
  );
}

/** A minute of the day picked from a list or typed; `from` shows lengths ("30 min") after a start. */
export function TimeField({ minute, onChange, locale, h12, from, disabled, label }: { minute: number; onChange: (m: number) => void; locale: string; h12: boolean; from?: number; disabled?: boolean; label: string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [text, setText] = useState("");
  const list = useMemo(() => {
    const out: number[] = [];
    const startAt = from !== undefined ? from + 15 : 0;
    for (let m = startAt; m < startAt + 1440 && out.length < 96; m += 15) if (from === undefined || m <= from + 1440) out.push(m);
    return out;
  }, [from]);
  return (
    <>
      <button type="button" className="cal-field-btn" disabled={disabled} aria-label={label} onClick={(e) => (setText(""), setAnchor(e.currentTarget))}>
        {fmtMinute(minute % 1440, locale, h12, false)}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={200} label={label}>
          <input
            className="cal-input"
            autoFocus
            value={text}
            placeholder={fmtMinute(minute % 1440, locale, h12, false)}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const hm = parseTimeInput(text);
              if (!hm) return;
              let m = Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));
              if (from !== undefined && m <= from) m += 1440;
              onChange(m);
              setAnchor(null);
            }}
          />
          <div className="cal-time-list" role="listbox" aria-label={label}>
            {list.map((m) => (
              <button
                key={m}
                type="button"
                role="option"
                aria-selected={m === minute}
                className="cal-time-opt"
                data-sel={m === minute || undefined}
                ref={(el) => {
                  if (el && m === minute) el.scrollIntoView({ block: "center" });
                }}
                onClick={() => {
                  onChange(m);
                  setAnchor(null);
                }}
              >
                <span>{fmtMinute(m % 1440, locale, h12, false)}</span>
                {from !== undefined && <span className="cal-time-len">{fmtDuration(m - from, locale)}</span>}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

export function ZonePicker({ value, onChange, t, now, disabled, compact, placeholder }: { value: string; onChange: (z: string) => void; t: CT; now: number; disabled?: boolean; compact?: boolean; placeholder?: string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [q, setQ] = useState("");
  const zones = useMemo(() => allZones(), []);
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase().replace(/\s+/g, "_");
    return (s ? zones.filter((z) => z.toLowerCase().includes(s) || offsetLabel(now, z).toLowerCase().replace("−", "-").includes(s.replace("−", "-"))) : zones).slice(0, 150);
  }, [q, zones, now]);
  return (
    <>
      <button type="button" className={`cal-field-btn${compact ? " cal-field-btn-sm" : ""}`} disabled={disabled} aria-label={t("ev.tz")} onClick={(e) => (setQ(""), setAnchor(e.currentTarget))}>
        <Globe size={13} aria-hidden />
        {placeholder ? (
          <span>{placeholder}</span>
        ) : (
          <span>
            {zoneCity(value)} <span className="cal-muted">{offsetLabel(now, value)}</span>
          </span>
        )}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={300} label={t("ev.tz")}>
          <input className="cal-input" autoFocus value={q} placeholder={t("set.zoneSearch")} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && hits[0] && (onChange(hits[0]), setAnchor(null))} />
          <div className="cal-time-list" role="listbox" aria-label={t("ev.tz")}>
            {hits.map((z) => (
              <button key={z} type="button" role="option" aria-selected={z === value} className="cal-time-opt" data-sel={z === value || undefined} onClick={() => (onChange(z), setAnchor(null))}>
                <span>{z.replace(/_/g, " ")}</span>
                <span className="cal-time-len">{offsetLabel(now, z)}</span>
              </button>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}
