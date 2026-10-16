"use client";

// Repeat of an event: Notion Calendar's presets from the event's own day
// ("Every week on Thursday", "Every month on the third Thursday"…) and a
// custom rule (every N days / weeks on chosen weekdays / months / years,
// ending never, on a date, or after a number of times). Rules are RRULE text.

import { useState } from "react";
import { Repeat as RepeatIcon } from "lucide-react";
import { formatRRule, parseRRule, type Freq, type RRule } from "@/lib/calendar/rrule";
import { addDays, addMonths, daysInMonth, parseDay, weekday } from "@/lib/calendar/tz";
import { fmtDate, fmtDay } from "./format";
import type { CT } from "./i18n";
import { DateField } from "./pickers";
import { Menu, Modal } from "./ui";

const wdName = (wd: number, locale: string, style: "long" | "short" | "narrow" = "long") => fmtDay(addDays("2026-10-11", wd), locale, { weekday: style });

function nthOf(day: string): number {
  const p = parseDay(day);
  return p.d + 7 > daysInMonth(p.y, p.m) ? -1 : Math.ceil(p.d / 7);
}

export function presets(day: string): { key: string; rule: string | null }[] {
  const wd = weekday(day);
  const code = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][wd];
  const p = parseDay(day);
  return [
    { key: "none", rule: null },
    { key: "daily", rule: "FREQ=DAILY" },
    { key: "weekdays", rule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" },
    { key: "weekly", rule: `FREQ=WEEKLY;BYDAY=${code}` },
    { key: "monthly", rule: `FREQ=MONTHLY;BYMONTHDAY=${p.d}` },
    { key: "monthlyNth", rule: `FREQ=MONTHLY;BYDAY=${nthOf(day)}${code}` },
    { key: "yearly", rule: "FREQ=YEARLY" },
  ];
}

/** A rule in words ("Every 2 weeks on Mon, Wed until Dec 31"). */
export function describeRule(rule: string | null, day: string, locale: string, t: CT): string {
  if (!rule) return t("rep.none");
  const r = parseRRule(rule);
  if (!r) return t("rep.custom");
  const p = parseDay(day);
  let base: string;
  const simple = r.interval === 1 && !r.bySetPos?.length;
  const days = r.byDay?.map((b) => b.wd) ?? [];
  if (simple && r.freq === "DAILY" && !r.byDay) base = t("rep.daily");
  else if (simple && r.freq === "WEEKLY" && days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) base = t("rep.weekdays");
  else if (simple && r.freq === "WEEKLY" && days.length <= 1) base = t("rep.weekly", { day: wdName(days[0] ?? weekday(day), locale) });
  else if (simple && r.freq === "MONTHLY" && r.byDay?.length === 1 && r.byDay[0].n) base = t("rep.monthlyNth", { nth: t(`nth.${r.byDay[0].n === -1 ? -1 : Math.min(5, r.byDay[0].n)}` as "nth.1"), day: wdName(r.byDay[0].wd, locale) });
  else if (simple && r.freq === "MONTHLY" && !r.byDay) base = t("rep.monthly", { n: r.byMonthDay?.[0] ?? p.d });
  else if (simple && r.freq === "YEARLY" && !r.byDay && !r.byMonth) base = t("rep.yearly", { date: fmtDay(day, locale, { month: "long", day: "numeric" }) });
  else {
    base = t("rep.everyN", { n: r.interval, unit: t(`rep.unit.${r.freq}` as "rep.unit.DAILY") });
    if (days.length) base += ` ${t("rep.onDays", { days: days.map((d) => wdName(d, locale, "short")).join(", ") })}`;
  }
  if (r.until) base += ` ${t("rep.until", { date: fmtDate(`${r.until.slice(0, 4)}-${r.until.slice(4, 6)}-${r.until.slice(6, 8)}`, locale) })}`;
  if (r.count) base += ` · ${t("rep.count", { n: r.count })}`;
  return base;
}

export function RepeatField({ rule, day, onChange, locale, t, disabled, tz, now, weekStart }: { rule: string | null; day: string; onChange: (r: string | null) => void; locale: string; t: CT; disabled?: boolean; tz: string; now: number; weekStart: number }) {
  const [menu, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [custom, setCustom] = useState(false);
  const label = (k: string, r: string | null) => (k === "none" ? t("rep.none") : describeRule(r, day, locale, t));
  return (
    <>
      <button type="button" className="cal-field-btn" disabled={disabled} aria-label={t("ev.repeat")} onClick={(e) => setMenuAnchor(e.currentTarget)}>
        <RepeatIcon size={13} aria-hidden />
        <span>{describeRule(rule, day, locale, t)}</span>
      </button>
      {menu && (
        <Menu
          anchor={menu}
          onClose={() => setMenuAnchor(null)}
          width={280}
          items={[
            ...presets(day).map((p) => ({ key: p.key, label: label(p.key, p.rule), checked: (p.rule ?? null) === (rule ?? null), run: () => onChange(p.rule) })),
            "sep" as const,
            { key: "custom", label: t("rep.custom"), run: () => setCustom(true) },
          ]}
        />
      )}
      {custom && <CustomRepeat rule={rule} day={day} locale={locale} t={t} tz={tz} now={now} weekStart={weekStart} onClose={() => setCustom(false)} onSave={(r) => (onChange(r), setCustom(false))} />}
    </>
  );
}

function CustomRepeat({ rule, day, locale, t, onClose, onSave, tz, now, weekStart }: { rule: string | null; day: string; locale: string; t: CT; onClose: () => void; onSave: (r: string) => void; tz: string; now: number; weekStart: number }) {
  const cur = rule ? parseRRule(rule) : null;
  const [freq, setFreq] = useState<Freq>(cur?.freq ?? "WEEKLY");
  const [interval, setInterval] = useState(cur?.interval ?? 1);
  const [days, setDays] = useState<number[]>(cur?.byDay?.filter((b) => !b.n).map((b) => b.wd) ?? [weekday(day)]);
  const [monthMode, setMonthMode] = useState<"day" | "nth">(cur?.byDay?.some((b) => b.n) ? "nth" : "day");
  const [ends, setEnds] = useState<"never" | "on" | "after">(cur?.until ? "on" : cur?.count ? "after" : "never");
  const [until, setUntil] = useState(cur?.until ? `${cur.until.slice(0, 4)}-${cur.until.slice(4, 6)}-${cur.until.slice(6, 8)}` : addMonths(day, 3));
  const [count, setCount] = useState(cur?.count ?? 10);
  const build = (): string => {
    const r: RRule = { freq, interval: Math.max(1, Math.min(999, interval)) };
    if (freq === "WEEKLY") r.byDay = [...new Set(days.length ? days : [weekday(day)])].sort().map((wd) => ({ wd }));
    if (freq === "MONTHLY") {
      if (monthMode === "nth") r.byDay = [{ n: nthOf(day), wd: weekday(day) }];
      else r.byMonthDay = [parseDay(day).d];
    }
    if (ends === "on") r.until = until.replace(/-/g, "");
    if (ends === "after") r.count = Math.max(1, Math.min(999, count));
    return formatRRule(r);
  };
  return (
    <Modal
      title={t("rep.customTitle")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="cal-btn" onClick={onClose}>
            {t("c.cancel")}
          </button>
          <button type="button" className="cal-btn cal-btn-primary" onClick={() => onSave(build())}>
            {t("c.done")}
          </button>
        </>
      }
    >
      <div className="cal-form">
        <div className="cal-row">
          <span className="cal-row-label">{t("rep.every")}</span>
          <input className="cal-input cal-input-num" type="number" min={1} max={999} value={interval} onChange={(e) => setInterval(Number(e.target.value) || 1)} aria-label={t("rep.every")} />
          <select className="cal-select" value={freq} onChange={(e) => setFreq(e.target.value as Freq)} aria-label={t("rep.every")}>
            {(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const).map((f) => (
              <option key={f} value={f}>
                {t(`rep.unit.${f}`)}
              </option>
            ))}
          </select>
        </div>
        {freq === "WEEKLY" && (
          <div className="cal-row">
            <span className="cal-row-label">{t("rep.on")}</span>
            <div className="cal-wd-toggles" role="group" aria-label={t("rep.on")}>
              {Array.from({ length: 7 }, (_, i) => (weekStart + i) % 7).map((wd) => (
                <button key={wd} type="button" aria-pressed={days.includes(wd)} className="cal-wd" data-on={days.includes(wd) || undefined} onClick={() => setDays((d) => (d.includes(wd) ? d.filter((x) => x !== wd) : [...d, wd]))} title={wdName(wd, locale)}>
                  {wdName(wd, locale, "narrow")}
                </button>
              ))}
            </div>
          </div>
        )}
        {freq === "MONTHLY" && (
          <div className="cal-row">
            <select className="cal-select cal-grow" value={monthMode} onChange={(e) => setMonthMode(e.target.value as "day" | "nth")} aria-label={t("rep.on")}>
              <option value="day">{t("rep.monthly", { n: parseDay(day).d })}</option>
              <option value="nth">{t("rep.monthlyNth", { nth: t(`nth.${nthOf(day)}` as "nth.1"), day: wdName(weekday(day), locale) })}</option>
            </select>
          </div>
        )}
        <div className="cal-row cal-row-top">
          <span className="cal-row-label">{t("rep.ends")}</span>
          <div className="cal-radios" role="radiogroup" aria-label={t("rep.ends")}>
            <label>
              <input type="radio" checked={ends === "never"} onChange={() => setEnds("never")} /> {t("rep.never")}
            </label>
            <label>
              <input type="radio" checked={ends === "on"} onChange={() => setEnds("on")} /> {t("rep.onDate")}
              <DateField value={until} onChange={setUntil} locale={locale} tz={tz} now={now} weekStart={weekStart} t={t} disabled={ends !== "on"} label={t("rep.onDate")} />
            </label>
            <label>
              <input type="radio" checked={ends === "after"} onChange={() => setEnds("after")} /> {t("rep.after")}
              <input className="cal-input cal-input-num" type="number" min={1} max={999} disabled={ends !== "after"} value={count} onChange={(e) => setCount(Number(e.target.value) || 1)} aria-label={t("rep.times")} /> {t("rep.times")}
            </label>
          </div>
        </div>
      </div>
    </Modal>
  );
}
