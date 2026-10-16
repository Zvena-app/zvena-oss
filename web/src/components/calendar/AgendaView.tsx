"use client";

// The agenda: the coming days as a list, each day with its events in order.

import type { CSSProperties } from "react";
import { MapPin, Repeat, Video } from "lucide-react";
import { addDays, dayOf } from "@/lib/calendar/tz";
import type { CalendarInfo } from "@/lib/calendar/types";
import { fmtDateLong, fmtTime } from "./format";
import type { CT } from "./i18n";
import { colorOf, joinUrl, type GridItem } from "./model";

export function AgendaView({ days, items, tz, locale, h12, cals, now, today, selected, t, onSelect }: {
  days: readonly string[];
  items: readonly GridItem[];
  tz: string;
  locale: string;
  h12: boolean;
  cals: ReadonlyMap<string, CalendarInfo>;
  now: number;
  today: string;
  selected: string | null;
  t: CT;
  onSelect: (item: GridItem) => void;
}) {
  const onDay = (d: string) =>
    items
      .filter((it) => (it.allDay ? it.startDay <= d && it.endDay > d : dayOf(it.start, tz) <= d && dayOf(Math.max(it.start, it.end - 1), tz) >= d))
      .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start);
  const list = days.map((d) => ({ d, its: onDay(d) })).filter((x) => x.its.length);
  if (!list.length) return <div className="cal-agenda-empty">{t("c.agendaEmpty")}</div>;
  return (
    <div className="cal-agenda" role="list">
      {list.map(({ d, its }) => (
        <section key={d} className="cal-agenda-day" data-today={d === today || undefined} role="listitem">
          <h3>{fmtDateLong(d, locale)}</h3>
          {its.map((it) => {
            const ev = it.kind === "event" ? it.event : null;
            const join = ev ? joinUrl(ev) : null;
            return (
              <button
                key={`${it.key}@${d}`}
                type="button"
                data-key={it.key}
                className={`cal-agenda-row${it.end <= now ? " cal-ev-past" : ""}${selected === it.key ? " cal-ev-sel" : ""}${ev?.rsvp === "declined" ? " cal-ev-declined" : ""}`}
                style={{ "--ev": ev ? colorOf(ev, cals) : it.kind === "layer" ? it.layer.color : undefined } as CSSProperties}
                onClick={() => onSelect(it)}
              >
                <span className="cal-agenda-when">{it.allDay ? t("c.allDay") : `${fmtTime(it.start, tz, locale, h12)} – ${fmtTime(it.end, tz, locale, h12)}`}</span>
                <span className="cal-agenda-dot" />
                <span className="cal-agenda-title">
                  {(ev ? ev.title : it.kind === "layer" ? it.layer.title : "") || t("ev.untitled")}
                  {it.kind === "layer" && it.layer.sub && <span className="cal-agenda-sub">{it.layer.sub}</span>}
                </span>
                <span className="cal-agenda-meta">
                  {ev?.recurring && <Repeat size={12} aria-label={t("c.repeats")} />}
                  {ev?.location && (
                    <span className="cal-agenda-where">
                      <MapPin size={12} aria-hidden />
                      {ev.location}
                    </span>
                  )}
                  {join && <Video size={12} aria-label={t("ev.conference")} />}
                </span>
              </button>
            );
          })}
        </section>
      ))}
      <div className="cal-agenda-end" aria-hidden>
        {fmtDateLong(addDays(days[days.length - 1], 0), locale)}
      </div>
    </div>
  );
}
