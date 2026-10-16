import type { Metadata, Viewport } from "next";
import { redirect } from "next/navigation";
import { CalendarApp } from "@/components/calendar/CalendarApp";
import { Messages } from "@/i18n/Messages";
import { messagesOf } from "@/i18n/runtime";
import { weekStartOf } from "@/components/calendar/format";
import { visibleDays } from "@/components/calendar/model";
import { initialCalendar } from "@/lib/calendar/api";
import { calText } from "@/lib/calendar/strings";
import { addDays, atMinute, dayOf, isDay } from "@/lib/calendar/tz";
import type { Bootstrap, ViewKind } from "@/lib/calendar/types";
import type { Locale } from "@/i18n/locales";
import { pageLocale, requireUser } from "@/lib/page";

export async function generateMetadata(): Promise<Metadata> {
  return { title: calText(await pageLocale(), "app.name"), robots: { index: false, follow: false } };
}

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

// zvena Calendar: the calendars of the open workspace (members only — a
// guest of shared pages goes to their own workspace). The app runs in the
// browser (src/components/calendar) against /api/calendar; the address
// keeps the day, the view and an open event (?date=, ?view=, ?event=).

type Props = { searchParams: Promise<{ ws?: string; team?: string; date?: string; view?: string; event?: string; occ?: string; new?: string }> };

const VIEWS: readonly string[] = ["day", "week", "month", "agenda"];

/** When the page's copy was read (the app reads it again when it is old). */
const readAt = () => Date.now();

/**
 * The range the app opens with on a wide screen (CalendarApp: the view's days,
 * a day either side) and the coming week from an hour ago (its "next" card).
 */
function firstRange(b: Bootstrap, initial: { date?: string; view?: ViewKind }, locale: Locale, now: number) {
  const tz = b.prefs.tz;
  const days = visibleDays({ view: initial.view ?? b.prefs.view, anchor: initial.date ?? dayOf(now, tz) }, b.prefs, weekStartOf(b.prefs, locale), false);
  const start = now - 3_600_000;
  return { from: atMinute(addDays(days[0], -1), 0, tz), to: atMinute(addDays(days[days.length - 1], 2), 0, tz), upcomingFrom: start, upcomingTo: start + 8 * 86_400_000 };
}

export default async function CalendarPage({ searchParams }: Props) {
  const sp = await searchParams;
  const { user, locale } = await requireUser("/calendar", sp.ws, sp.team);
  if (user.ws.role === "guest") redirect("/calendar");
  const initial = {
    ...(isDay(sp.date) ? { date: sp.date } : {}),
    ...(sp.view && VIEWS.includes(sp.view) ? { view: sp.view as ViewKind } : {}),
    ...(sp.event && /^[A-Za-z0-9_-]{6,64}$/.test(sp.event) ? { event: sp.event } : {}),
    ...(sp.occ && /^\d{8}(T\d{6}Z)?$/.test(sp.occ) ? { occ: sp.occ } : {}),
    ...(sp.new === "1" ? { create: true } : {}),
  };
  // The bootstrap and the first view's events come with the page (no round trip before they show).
  const at = readAt();
  const data = await initialCalendar({ id: user.id, name: user.name, ...(user.email ? { email: user.email } : {}) }, user.ws.id, locale, (b) => firstRange(b, initial, locale, at));
  // Calendar's words, and Projects' (its description editor) in the page's language.
  return (
    <Messages ns="calendar" locale={locale} dict={messagesOf("calendar", locale)}>
      <Messages ns="projects" locale={locale} dict={messagesOf("projects", locale)}>
        <CalendarApp user={user} initial={initial} data={data} dataAt={at} />
      </Messages>
    </Messages>
  );
}
