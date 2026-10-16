"use client";

// The public booking page of a scheduling link (/cal/<slug>), and the
// guest's own page to reschedule or cancel (/cal/<slug>/<token>). Signed
// out; the server sent the link's public words and the first free times; the
// visitor's own zone shows them (changeable), and booking checks the time
// again on the server.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { CalendarCheck, ChevronLeft, ChevronRight, Clock, Globe, MapPin, Video } from "lucide-react";
import { calText, type CalKey } from "@/lib/calendar/strings";
import { addDays, addMonths, dayOf, localZone, parseDay, startOfMonth, startOfWeek, validTimeZone } from "@/lib/calendar/tz";
import { useI18n } from "@/lib/i18n-react";
import { dayNum, fmtDate, fmtDateLong, fmtDay, fmtTime, uses12h, weekStartOf, weekdayShort } from "../format";
import { ZonePicker } from "../pickers";
import "../calendar.css";
import "./booking.css";

export interface PublicLinkView {
  slug: string;
  title: string;
  description: string;
  duration: number;
  hostName: string;
  location: string;
  video: boolean;
  tz: string;
  windowDays: number;
  color: string;
}

export interface ManagedView {
  token: string;
  name: string;
  email: string;
  start: number;
  end: number;
  tz: string;
  canceled: boolean;
}

const DAY = 86_400_000;

export function BookingPage({ link, initialSlots, now, managed }: { link: PublicLinkView; initialSlots: number[]; now: number; managed?: ManagedView }) {
  const { locale } = useI18n();
  const t = (k: CalKey, v?: Record<string, string | number>) => calText(locale, k, v);
  // The host's zone on the server's render; the visitor's once the page runs.
  const [tz, setTz] = useState(link.tz);
  useEffect(() => {
    const z = managed?.tz && validTimeZone(managed.tz) ? managed.tz : localZone();
    const tm = setTimeout(() => setTz(z), 0);
    return () => clearTimeout(tm);
  }, [managed?.tz]);
  const [slots, setSlots] = useState<number[]>(initialSlots);
  const [month, setMonth] = useState(() => dayOf(initialSlots[0] ?? now, link.tz));
  const [day, setDay] = useState<string | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const [state, setState] = useState<"pick" | "form" | "sending" | "done" | "canceled">(managed?.canceled ? "canceled" : "pick");
  const [err, setErr] = useState("");
  const [done, setDone] = useState<{ start: number; manage?: string; mailed?: boolean } | null>(null);
  const [form, setForm] = useState({ name: "", email: "", note: "", website: "" });
  const h12 = uses12h(locale, null);
  const weekStart = weekStartOf({ weekStart: -1 }, locale);

  // Free times of the month shown (two months at most per request).
  useEffect(() => {
    const first = startOfMonth(month);
    const from = Math.max(now, Date.parse(`${first}T00:00:00Z`) - DAY);
    const to = Math.min(now + (link.windowDays + 1) * DAY, Date.parse(`${addMonths(first, 1)}T00:00:00Z`) + DAY);
    if (to <= from) return;
    const ctl = new AbortController();
    const q = new URLSearchParams({ from: String(from), to: String(to), ...(managed ? { t: managed.token } : {}) });
    void fetch(`/api/calendar/public/${link.slug}/slots?${q}`, { signal: ctl.signal, cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { slots: [] }))
      .then((r: { slots: number[] }) => setSlots((cur) => [...new Set([...cur.filter((s) => s < from || s >= to), ...r.slots])].sort((a, b) => a - b)))
      .catch(() => undefined);
    return () => ctl.abort();
  }, [month, link.slug, link.windowDays, now, managed]);

  const byDay = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const s of slots) {
      const d = dayOf(s, tz);
      (m.get(d) ?? m.set(d, []).get(d)!).push(s);
    }
    return m;
  }, [slots, tz]);
  const firstFree = useMemo(() => [...byDay.keys()].sort()[0] ?? null, [byDay]);
  const shownDay = day ?? firstFree;
  const today = dayOf(now, tz);
  const grid = useMemo(() => {
    const first = startOfMonth(month);
    const start = startOfWeek(first, weekStart);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [month, weekStart]);

  const submit = async () => {
    if (pick === null) return;
    setState("sending");
    setErr("");
    try {
      const url = managed ? `/api/calendar/public/${link.slug}/booking/${managed.token}/reschedule` : `/api/calendar/public/${link.slug}/book`;
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(managed ? { start: pick } : { ...form, start: pick, tz, locale }) });
      const data = (await res.json().catch(() => ({}))) as { error?: string; manage?: string; mailed?: boolean };
      if (!res.ok) {
        setErr(res.status === 409 ? t("book.taken") : res.status === 429 ? (data.error === "limit" ? t("book.limit") : t("book.rate")) : t("book.error"));
        setState(managed ? "pick" : "form");
        if (res.status === 409) {
          setSlots((s) => s.filter((x) => x !== pick));
          setPick(null);
        }
        return;
      }
      setDone({ start: pick, manage: data.manage, mailed: data.mailed });
      setState("done");
    } catch {
      setErr(t("book.error"));
      setState(managed ? "pick" : "form");
    }
  };
  const cancel = async () => {
    if (!managed || !confirm(t("book.cancelConfirm"))) return;
    const res = await fetch(`/api/calendar/public/${link.slug}/booking/${managed.token}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (res.ok) setState("canceled");
    else setErr(t("book.error"));
  };

  const when = (s: number) => `${fmtDateLong(dayOf(s, tz), locale)} · ${fmtTime(s, tz, locale, h12, false)} – ${fmtTime(s + link.duration * 60_000, tz, locale, h12, false)}`;

  return (
    <main className="bk" style={{ "--bk": link.color || "var(--ui-brand)" } as CSSProperties}>
      <div className="bk-card">
        <aside className="bk-info">
          <div className="bk-host">{link.hostName}</div>
          <h1>{link.title}</h1>
          <div className="bk-meta">
            <Clock size={15} aria-hidden /> {t("book.min", { n: link.duration })}
          </div>
          {link.video && (
            <div className="bk-meta">
              <Video size={15} aria-hidden /> {t("ev.conference")}
            </div>
          )}
          {link.location && (
            <div className="bk-meta">
              <MapPin size={15} aria-hidden /> {link.location}
            </div>
          )}
          {link.description && <p className="bk-desc">{link.description}</p>}
          {managed && state !== "canceled" && (
            <div className="bk-current">
              <CalendarCheck size={15} aria-hidden /> {when(managed.start)}
            </div>
          )}
        </aside>
        <section className="bk-main">
          {state === "canceled" && <p className="bk-big">{t("book.canceled")}</p>}
          {state === "done" && done && (
            <div className="bk-done" data-testid="booking-done">
              <CalendarCheck size={28} aria-hidden />
              <h2>{managed ? t("book.rescheduled") : t("book.booked")}</h2>
              <p>{when(done.start)}</p>
              {!managed && done.mailed !== false && <p className="bk-muted">{t("book.bookedHint", { email: form.email })}</p>}
              {!managed && done.mailed === false && done.manage && (
                <>
                  <p className="bk-muted">{t("book.noMailHint")}</p>
                  <p>
                    <a href={done.manage} data-testid="booking-manage">
                      {t("book.manageLink")}
                    </a>
                  </p>
                </>
              )}
            </div>
          )}
          {(state === "pick" || state === "form" || state === "sending") && (
            <>
              {state === "pick" && (
                <div className="bk-pick">
                  <div className="bk-cal">
                    <div className="bk-cal-head">
                      <h2>{fmtDay(startOfMonth(month), locale, { month: "long", year: "numeric" })}</h2>
                      <button type="button" className="bk-nav" aria-label={t("book.prevMonth")} disabled={startOfMonth(month) <= startOfMonth(today)} onClick={() => setMonth(addMonths(startOfMonth(month), -1))}>
                        <ChevronLeft size={16} className="bk-flip" />
                      </button>
                      <button type="button" className="bk-nav" aria-label={t("book.nextMonth")} onClick={() => setMonth(addMonths(startOfMonth(month), 1))}>
                        <ChevronRight size={16} className="bk-flip" />
                      </button>
                    </div>
                    <div className="bk-grid" role="grid" aria-label={t("book.pickDay")}>
                      {grid.slice(0, 7).map((d) => (
                        <span key={`w${d}`} className="bk-wd">
                          {weekdayShort(d, locale)}
                        </span>
                      ))}
                      {grid.map((d) => {
                        const free = byDay.has(d);
                        return (
                          <button
                            key={d}
                            type="button"
                            className="bk-day"
                            disabled={!free}
                            data-out={parseDay(d).m !== parseDay(month).m || undefined}
                            data-sel={d === shownDay || undefined}
                            data-today={d === today || undefined}
                            aria-label={fmtDate(d, locale)}
                            onClick={() => (setDay(d), setPick(null))}
                          >
                            {dayNum(d, locale)}
                          </button>
                        );
                      })}
                    </div>
                    <div className="bk-tz">
                      <Globe size={14} aria-hidden />
                      <span>{t("book.tz")}</span>
                      <ZonePicker value={tz} onChange={setTz} t={(k, v) => calText(locale, k, v)} now={now} compact />
                    </div>
                  </div>
                  <div className="bk-slots">
                    <h3>{shownDay ? fmtDateLong(shownDay, locale) : t("book.pickTime")}</h3>
                    {!firstFree && <p className="bk-muted">{t("book.noMore")}</p>}
                    {shownDay && !(byDay.get(shownDay)?.length ?? 0) && firstFree && <p className="bk-muted">{t("book.noSlots")}</p>}
                    <div className="bk-slot-list" role="list">
                      {(shownDay ? (byDay.get(shownDay) ?? []) : []).map((s) => (
                        <div key={s} className="bk-slot-row" role="listitem">
                          <button type="button" className="bk-slot" data-sel={pick === s || undefined} onClick={() => setPick(s)} data-testid="slot">
                            {fmtTime(s, tz, locale, h12, false)}
                          </button>
                          {pick === s && (
                            <button type="button" className="bk-next" onClick={() => (managed ? void submit() : setState("form"))} data-testid="slot-next">
                              {managed ? t("book.reschedule") : t("book.confirm")}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              {(state === "form" || state === "sending") && pick !== null && (
                <form
                  className="bk-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void submit();
                  }}
                >
                  <button type="button" className="bk-back" onClick={() => setState("pick")}>
                    <ChevronLeft size={15} className="bk-flip" /> {t("book.back")}
                  </button>
                  <p className="bk-when">{when(pick)}</p>
                  <label>
                    {t("book.name")}
                    <input required maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" data-testid="book-name" />
                  </label>
                  <label>
                    {t("book.email")}
                    <input required type="email" maxLength={254} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" data-testid="book-email" />
                  </label>
                  <label>
                    {t("book.note")}
                    <textarea maxLength={1000} rows={3} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
                  </label>
                  {/* People never see this field; bots fill it in. */}
                  <label className="bk-hp" aria-hidden="true">
                    Website
                    <input tabIndex={-1} autoComplete="off" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
                  </label>
                  <button type="submit" className="bk-next" disabled={state === "sending"} data-testid="book-confirm">
                    {t("book.confirm")}
                  </button>
                </form>
              )}
              {err && <p className="bk-err" role="alert">{err}</p>}
            </>
          )}
          {managed && state === "pick" && (
            <button type="button" className="bk-cancel" onClick={() => void cancel()}>
              {t("book.cancel")}
            </button>
          )}
        </section>
      </div>
      <p className="bk-brand">{t("book.brand")}</p>
    </main>
  );
}

/** A link that is off, a booking or an invitation that is gone. */
export function Missing({ text }: { text: string }) {
  return (
    <main className="bk">
      <div className="bk-card bk-card-narrow">
        <p className="bk-big">{text}</p>
      </div>
    </main>
  );
}

export function InvitePage({ token, info }: { token: string; info: { title: string; when: string; location: string; rsvp: string } | null }) {
  const { locale } = useI18n();
  const t = (k: CalKey, v?: Record<string, string | number>) => calText(locale, k, v);
  const [rsvp, setRsvp] = useState(info?.rsvp ?? "needs-action");
  const [saved, setSaved] = useState(false);
  if (!info)
    return (
      <main className="bk">
        <div className="bk-card bk-card-narrow">
          <p className="bk-big">{t("inv.notFound")}</p>
        </div>
      </main>
    );
  const answer = async (a: "accepted" | "declined" | "tentative") => {
    const res = await fetch(`/api/calendar/invite/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rsvp: a }) });
    if (res.ok) {
      setRsvp(a);
      setSaved(true);
    }
  };
  return (
    <main className="bk">
      <div className="bk-card bk-card-narrow">
        <section className="bk-main">
          <div className="bk-host">{t("inv.title")}</div>
          <h1>{info.title || t("ev.untitled")}</h1>
          <div className="bk-meta">
            <Clock size={15} aria-hidden /> {info.when}
          </div>
          {info.location && (
            <div className="bk-meta">
              <MapPin size={15} aria-hidden /> {info.location}
            </div>
          )}
          <p>{t("ev.going")}</p>
          <div className="bk-answers">
            {(["accepted", "declined", "tentative"] as const).map((a) => (
              <button key={a} type="button" className="bk-slot" data-sel={rsvp === a || undefined} onClick={() => void answer(a)}>
                {t(`rsvp.${a}`)}
              </button>
            ))}
          </div>
          {saved && <p className="bk-muted">{t("inv.thanks")}</p>}
        </section>
      </div>
      <p className="bk-brand">{t("book.brand")}</p>
    </main>
  );
}
