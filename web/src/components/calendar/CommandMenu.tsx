"use client";

// Calendar's ⌘K (Notion Calendar's command menu): type a command, a date in
// plain words ("next fri" → go there, or make an event there), an event to
// find, or anything of the workspace (the ecosystem's search: docs, issues,
// projects, designs). ↑ ↓ to move, Enter to run, Esc to close.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, CalendarDays, CalendarPlus, Eye, EyeOff, Keyboard, Link2, Plus, Search, Settings, Upload, Video, Globe2, Database } from "lucide-react";
import { useSearch } from "@/components/eco/SearchList";
import { KindIcon } from "@/components/eco/CardView";
import { parseJump } from "@/lib/calendar/natural";
import type { EventDetail, ViewKind } from "@/lib/calendar/types";
import { calApi } from "./api";
import { useCal } from "./context";
import { fmtDate, fmtDateLong, fmtTime } from "./format";

export interface Command {
  key: string;
  label: string;
  icon: ReactNode;
  hint?: string;
  group: string;
  run: () => void;
}

export function CommandMenu({ onClose, onGoto, onView, onCreate, onToday, onJoin }: { onClose: () => void; onGoto: (day: string) => void; onView: (v: ViewKind) => void; onCreate: (day?: string) => void; onToday: () => void; onJoin: () => void }) {
  const c = useCal();
  const { t, actions } = c;
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const [events, setEvents] = useState<EventDetail[]>([]);
  const { hits } = useSearch(c.ws, q.trim().length >= 2 ? q : "", ["note", "issue", "project", "design"]);

  useEffect(() => {
    const s = q.trim();
    if (s.length < 2) return;
    const ctl = new AbortController();
    const tm = setTimeout(() => {
      void calApi<{ items: EventDetail[] }>(c.ws, "search", { query: { q: s }, signal: ctl.signal })
        .then((r) => setEvents(r.items.slice(0, 8)))
        .catch(() => undefined);
    }, 120);
    return () => {
      clearTimeout(tm);
      ctl.abort();
    };
  }, [q, c.ws]);

  const list = useMemo<Command[]>(() => {
    const run = (fn: () => void) => () => {
      onClose();
      fn();
    };
    const g = t("cmd.commands");
    const day = q.trim() ? parseJump(q, c.locale, c.now, c.tz) : null;
    const out: Command[] = [];
    if (day) {
      out.push({ key: "goto", label: t("cmd.goto", { date: fmtDateLong(day, c.locale) }), icon: <ArrowRight size={15} />, group: g, run: run(() => onGoto(day)) });
      out.push({ key: "create-at", label: t("cmd.createAt", { date: fmtDate(day, c.locale) }), icon: <CalendarPlus size={15} />, group: g, run: run(() => onCreate(day)) });
    }
    const commands: Command[] = [
      { key: "create", label: t("cmd.create"), icon: <CalendarPlus size={15} />, hint: "C", group: g, run: run(() => onCreate()) },
      { key: "today", label: t("key.today"), icon: <CalendarDays size={15} />, hint: "T", group: g, run: run(onToday) },
      { key: "goto-date", label: t("nav.goto"), icon: <ArrowRight size={15} />, hint: "G", group: g, run: run(() => actions.dialog({ kind: "goto" })) },
      { key: "join", label: t("cmd.join"), icon: <Video size={15} />, hint: "⌘J", group: g, run: run(onJoin) },
      { key: "v-day", label: t("view.day"), icon: <CalendarDays size={15} />, hint: "D", group: t("cmd.views"), run: run(() => onView("day")) },
      { key: "v-week", label: t("view.week"), icon: <CalendarDays size={15} />, hint: "W", group: t("cmd.views"), run: run(() => onView("week")) },
      { key: "v-month", label: t("view.month"), icon: <CalendarDays size={15} />, hint: "M", group: t("cmd.views"), run: run(() => onView("month")) },
      { key: "v-agenda", label: t("view.agenda"), icon: <CalendarDays size={15} />, hint: "A", group: t("cmd.views"), run: run(() => onView("agenda")) },
      { key: "share", label: t("cmd.share"), icon: <Link2 size={15} />, group: g, run: run(() => actions.dialog({ kind: "link", id: null })) },
      { key: "availability", label: t("avail.title"), icon: <CalendarDays size={15} />, group: g, run: run(() => actions.dialog({ kind: "availability" })) },
      { key: "zones", label: t("cmd.zones"), icon: <Globe2 size={15} />, hint: "Z", group: g, run: run(() => actions.dialog({ kind: "zones" })) },
      { key: "new-cal", label: t("cmd.newCalendar"), icon: <Plus size={15} />, group: g, run: run(() => actions.dialog({ kind: "calendar", id: null })) },
      { key: "subscribe", label: t("cmd.subscribe"), icon: <Link2 size={15} />, group: g, run: run(() => actions.dialog({ kind: "subscribe" })) },
      { key: "import", label: t("cmd.import"), icon: <Upload size={15} />, group: g, run: run(() => actions.dialog({ kind: "import" })) },
      { key: "layer", label: t("lay.addDocs"), icon: <Database size={15} />, group: g, run: run(() => actions.dialog({ kind: "layer" })) },
      { key: "settings", label: t("nav.settings"), icon: <Settings size={15} />, hint: ",", group: g, run: run(() => actions.dialog({ kind: "settings" })) },
      { key: "keys", label: t("nav.shortcuts"), icon: <Keyboard size={15} />, hint: "?", group: g, run: run(() => actions.dialog({ kind: "shortcuts" })) },
      ...c.boot.calendars.map((cal) => ({
        key: `cal-${cal.id}`,
        label: t("rail.toggle", { name: cal.name }),
        icon: cal.hidden ? <EyeOff size={15} /> : <Eye size={15} />,
        group: t("cmd.calendars"),
        run: run(() => void actions.setHidden(cal, !cal.hidden)),
      })),
    ];
    const s = q.trim().toLowerCase();
    out.push(...(s ? commands.filter((x) => x.label.toLowerCase().includes(s)) : commands.filter((x) => !x.key.startsWith("cal-"))));
    for (const e of q.trim().length >= 2 ? events : [])
      out.push({
        key: `ev-${e.id}`,
        label: e.title || t("ev.untitled"),
        hint: e.allDay ? fmtDate(e.startDay, c.locale) : `${fmtDate(e.startDay, c.locale)} ${fmtTime(e.start, c.tz, c.locale, c.h12)}`,
        icon: <span className="cal-dot" style={{ background: e.color ?? c.cals.get(e.calId)?.color }} />,
        group: t("cmd.events"),
        run: run(() => {
          onGoto(e.startDay);
          actions.open({ kind: "event", id: e.id, occ: null });
        }),
      });
    for (const h of hits.slice(0, 8))
      out.push({ key: `eco-${h.key}`, label: h.title, hint: h.sub, icon: <KindIcon card={h} size={15} />, group: t("cmd.workspace"), run: run(() => window.location.assign(h.url)) });
    return out;
  }, [q, c, events, hits, t, actions, onClose, onGoto, onView, onCreate, onToday, onJoin]);

  const groups = [...new Set(list.map((x) => x.group))];
  return createPortal(
    <div className="cal-layer">
      <div className="cal-scrim" onMouseDown={onClose} />
      <div className="cal-cmd" role="dialog" aria-modal="true" aria-label={t("nav.menu")}>
        <div className="cal-cmd-input">
          <Search size={16} aria-hidden />
          <input
            autoFocus
            value={q}
            placeholder={t("cmd.placeholder")}
            onChange={(e) => {
              setQ(e.target.value);
              setAt(0);
            }}
            aria-label={t("nav.menu")}
            data-testid="cmd-input"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                onClose();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setAt((i) => Math.min(list.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setAt((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                list[at]?.run();
              }
            }}
          />
        </div>
        <div className="cal-cmd-list" role="listbox" aria-label={t("nav.menu")}>
          {list.length === 0 && <div className="cal-menu-empty">{t("cmd.empty")}</div>}
          {groups.map((g) => (
            <div key={g} role="group" aria-label={g}>
              <div className="cal-cmd-group">{g}</div>
              {list
                .filter((x) => x.group === g)
                .map((x) => {
                  const i = list.indexOf(x);
                  return (
                    <button key={x.key} type="button" role="option" aria-selected={i === at} className="cal-menu-item" data-active={i === at || undefined} onMouseEnter={() => setAt(i)} onClick={x.run}>
                      <span className="cal-menu-icon">{x.icon}</span>
                      <span className="cal-menu-label">{x.label}</span>
                      {x.hint && <span className="cal-menu-hint">{x.hint}</span>}
                    </button>
                  );
                })}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
