import type { Metadata, Viewport } from "next";
import { redirect } from "next/navigation";
import { CalendarApp } from "@/components/calendar/CalendarApp";
import { Messages } from "@/i18n/Messages";
import { messagesOf } from "@/i18n/runtime";
import { calText } from "@/lib/calendar/strings";
import { isDay } from "@/lib/calendar/tz";
import type { ViewKind } from "@/lib/calendar/types";
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
  // Calendar's words, and Projects' (its description editor) in the page's language.
  return (
    <Messages ns="calendar" locale={locale} dict={messagesOf("calendar", locale)}>
      <Messages ns="projects" locale={locale} dict={messagesOf("projects", locale)}>
        <CalendarApp user={user} initial={initial} />
      </Messages>
    </Messages>
  );
}
