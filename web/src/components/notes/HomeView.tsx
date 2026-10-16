"use client";

// Home (Notion's): the greeting in the display serif, the pages you visited
// last as cards, what is coming up (dates in pages and rows), quick-start
// chips, and where to learn more.

import { useEffect, useMemo, useState } from "react";
import { BookOpen, CalendarDays, Clock, FileText, Keyboard, LayoutTemplate, LifeBuoy, PenLine, Plus, Upload, Video } from "lucide-react";
import { currentWorkspace } from "@/lib/notes/workspace";
import { useNotes } from "./context";
import { displayTitle, safeUrl } from "@/lib/notes/model";
import { coverCss } from "./cover";
import { relativeTime } from "@/lib/notes/i18n";
import { templatesPart } from "./lazy";
import type { Note } from "@/lib/notes/types";
import type { NotesKey } from "@/lib/notes/i18n";
import { NoteIcon } from "./NoteIcon";
import { upcomingDates } from "@/lib/notes/upcoming";
import { localYmd } from "@/lib/notes/dates";
import { dateTimePart } from "@/lib/notes/reminders";
import { intlOf } from "@/i18n/locales";

/** Quick starts on Home, in the gallery's order. */
const QUICK_STARTS = ["todo", "meeting", "projects", "journal", "reading", "homework"];

export function HomeView() {
  const api = useNotes();
  const { t, snap, store, locale } = api;
  const h = new Date().getHours();
  const greet = h < 5 ? t("home.night") : h < 12 ? t("home.morning") : h < 18 ? t("home.afternoon") : t("home.evening");
  const name = api.user?.name?.split(/\s+/)[0];
  const recent = useMemo(() => {
    // Synced-block contents are never listed on their own.
    const fromVisits = store.meta.recent.map((r) => snap.byId.get(r.id)).filter((n): n is Note => Boolean(n) && !(n as Note).synced && !store.isTrashed((n as Note).id));
    if (fromVisits.length >= 6) return fromVisits.slice(0, 12);
    const more = [...snap.list]
      .filter((n) => !n.synced && !n.template && !store.isTrashed(n.id) && !fromVisits.includes(n) && !(n.parentId && snap.byId.get(n.parentId)?.kind === "database"))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return [...fromVisits, ...more].slice(0, 12);
  }, [snap.byId, snap.list, store]);
  // Dates of the next two weeks in pages and rows (Notion's upcoming events).
  const upcoming = useMemo(() => {
    const now = new Date();
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 14);
    return upcomingDates(snap.list, (id) => snap.byId.get(id)?.db, localYmd(now), localYmd(to), (n) => Boolean(n.synced) || store.isTrashed(n.id));
  }, [snap.byId, snap.list, store]);
  // Calendar's events of the same two weeks (Notion Home's "Upcoming events"), for signed-in members.
  const [events, setEvents] = useState<{ id: string; occ: string | null; title: string; start: number; allDay: boolean; startDay: string; conference: string; color: string | null }[]>([]);
  const signedIn = Boolean(api.user);
  useEffect(() => {
    const ws = currentWorkspace();
    if (!signedIn || !ws) return;
    const ctrl = new AbortController();
    const now = Date.now();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const q = new URLSearchParams({ ws, from: String(now), to: String(now + 14 * 86_400_000), tz, layers: "0" });
    fetch(`/api/calendar/events?${q}`, { credentials: "same-origin", signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((j: { items?: typeof events }) => setEvents((j.items ?? []).filter((e) => (e as { status?: string }).status !== "cancelled").slice(0, 20)))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [signedIn]);
  const eventWhen = (e: (typeof events)[number]) => {
    const loc = intlOf(locale);
    if (e.allDay) return new Date(`${e.startDay}T00:00:00`).toLocaleDateString(loc, { weekday: "short", month: "short", day: "numeric" });
    const d = new Date(e.start);
    return `${d.toLocaleDateString(loc, { weekday: "short", month: "short", day: "numeric" })}, ${d.toLocaleTimeString(loc, { hour: "numeric", minute: "2-digit" })}`;
  };
  // Pages' dates and Calendar's events, in time order.
  const agenda = useMemo(() => {
    const at = (date: string) => new Date(date.length > 10 ? date : `${date}T00:00:00`).getTime();
    return [
      ...upcoming.map((u) => ({ kind: "page" as const, at: at(u.date), u })),
      ...events.map((e) => ({ kind: "event" as const, at: e.allDay ? new Date(`${e.startDay}T00:00:00`).getTime() : e.start, e })),
    ].sort((a, b) => a.at - b.at);
  }, [upcoming, events]);
  const when = (date: string) => {
    const day = new Date(`${date.slice(0, 10)}T00:00:00`).toLocaleDateString(intlOf(locale), { weekday: "short", month: "short", day: "numeric" });
    const time = dateTimePart(date);
    return time ? `${day}, ${new Date(`${date.slice(0, 10)}T${time}:00`).toLocaleTimeString(intlOf(locale), { hour: "numeric", minute: "2-digit" })}` : day;
  };
  // The chips keep their places while the templates load (only the emoji arrives later).
  const tpl = templatesPart.use();
  return (
    <div className="nt-home">
      <h1 className="nt-home-greet">
        {greet}
        {name ? `, ${name}` : ""}
      </h1>
      <div className="nt-home-sec">
        <div className="nt-home-sec-title">
          <Clock />
          {t("home.recent")}
        </div>
        <div className="nt-home-cards">
          {recent.map((n) => (
            <button type="button" key={n.id} className="nt-home-card nt-btn-reset" onClick={() => api.open(n.id)}>
              {/* Notion's card: the page's cover as a strip (gray without one), the icon on its edge. */}
              <span className="nt-home-card-cover" style={n.cover && n.cover.kind !== "image" ? { background: coverCss(n.cover.value) } : undefined}>
                {n.cover?.kind === "image" && safeUrl(n.cover.value, true) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={n.cover.value} alt="" style={{ objectPosition: `center ${n.cover.y ?? 50}%` }} />
                ) : null}
              </span>
              <span className="nt-home-card-icon"><NoteIcon icon={n.icon} fallback={<FileText strokeWidth={1.6} />} /></span>
              <div className="nt-home-card-body">
                <div className="nt-home-card-title">{displayTitle(n, n.kind === "database" ? t("db.untitled") : t("page.untitled"))}</div>
                <div className="nt-home-card-meta">{relativeTime(t, locale, n.updatedAt)}</div>
              </div>
            </button>
          ))}
          {!api.readOnly && (
            <button type="button" className="nt-home-card nt-home-card-new nt-btn-reset" onClick={() => api.newPage(null)}>
              <Plus />
              {t("home.newPage")}
            </button>
          )}
        </div>
      </div>
      <div className="nt-home-sec">
        <div className="nt-home-sec-title">
          <CalendarDays />
          {t("home.upcoming")}
        </div>
        {agenda.length ? (
          <div className="nt-home-upcoming">
            {agenda.map((item) => {
              if (item.kind === "event") {
                const e = item.e;
                const href = `/calendar?ws=${encodeURIComponent(currentWorkspace())}&event=${encodeURIComponent(e.id)}${e.occ ? `&occ=${encodeURIComponent(e.occ)}` : ""}`;
                const join = e.conference && safeUrl(e.conference) ? e.conference : "";
                return (
                  <div key={`ev:${e.id}:${e.occ ?? ""}`} className="nt-home-event nt-home-event-cal" data-test="home-cal-event">
                    <a className="nt-home-event-link" href={href}>
                      <span className="nt-home-event-date">{eventWhen(e)}</span>
                      <span className="nt-home-event-title">
                        <span className="nt-home-event-dot" style={e.color ? { background: e.color } : undefined} />
                        {e.title || t("home.untitledEvent")}
                      </span>
                    </a>
                    {join && (
                      <a className="nt-btn nt-btn-reset nt-home-join" href={join} target="_blank" rel="noopener noreferrer">
                        <Video size={14} />
                        {t("home.join")}
                      </a>
                    )}
                  </div>
                );
              }
              const u = item.u;
              const n = snap.byId.get(u.noteId);
              return (
                <button type="button" key={u.key} className="nt-home-event nt-btn-reset" onClick={() => api.open(u.noteId, u.blockId ? { block: u.blockId } : undefined)}>
                  <span className="nt-home-event-date">{when(u.date)}</span>
                  <span className="nt-home-event-title">
                    <NoteIcon icon={n?.icon} fallback={<FileText strokeWidth={1.6} />} />
                    {displayTitle(n, t("page.untitled"))}
                  </span>
                  {u.text && <span className="nt-home-event-text">{u.text}</span>}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="nt-home-empty">{t("home.upcomingEmpty")}</p>
        )}
      </div>
      {/* Viewers and commenters cannot add pages. */}
      {!api.readOnly && (
        <div className="nt-home-sec">
          <div className="nt-home-sec-title">
            <LayoutTemplate />
            {t("home.quick")}
          </div>
          <div className="nt-home-grid">
            {QUICK_STARTS.map((key) => {
              const x = tpl?.TEMPLATES.find((y) => y.key === key);
              return (
                <button
                  type="button"
                  key={key}
                  className="nt-home-tile nt-btn-reset"
                  onClick={() => {
                    if (!tpl || !x) return;
                    const root = tpl.instantiateTemplate(x, locale, store, null);
                    api.open(root.id);
                  }}
                >
                  <span>{x?.icon}</span>
                  <span>{t(`tpl.${key}` as NotesKey)}</span>
                </button>
              );
            })}
            <button type="button" className="nt-home-tile nt-btn-reset" onClick={api.openTemplates}>
              <span>🧩</span>
              <span>{t("home.templates")}</span>
            </button>
            <button type="button" className="nt-home-tile nt-btn-reset" onClick={api.openImport}>
              <span>📥</span>
              <span>{t("home.import")}</span>
            </button>
          </div>
        </div>
      )}
      <div className="nt-home-sec">
        <div className="nt-home-sec-title">
          <BookOpen />
          {t("home.learn")}
        </div>
        <div className="nt-home-learn">
          <button type="button" className="nt-home-learn-item nt-btn-reset" onClick={() => api.openSettings("keys")}>
            <Keyboard />
            {t("home.learnShortcuts")}
          </button>
          {api.user && (
            <span className="nt-home-learn-item nt-home-learn-text">
              <PenLine />
              {t("home.learnSuggest")}
            </span>
          )}
          {!api.readOnly && (
            <button type="button" className="nt-home-learn-item nt-btn-reset" onClick={api.openImport}>
              <Upload />
              {t("home.learnImport")}
            </button>
          )}
          <a className="nt-home-learn-item" href="/help" target="_blank" rel="noopener noreferrer">
            <LifeBuoy />
            {t("home.learnHelp")}
          </a>
        </div>
      </div>
    </div>
  );
}

