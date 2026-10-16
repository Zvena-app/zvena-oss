import type { Metadata } from "next";
import { InvitePage } from "@/components/calendar/booking/BookingPage";
import { Messages } from "@/i18n/Messages";
import { messagesOf } from "@/i18n/runtime";
import { whenLine } from "@/lib/calendar/effects";
import { eventRow } from "@/lib/calendar/events";
import { tokenHash } from "@/lib/calendar/seal";
import { calText } from "@/lib/calendar/strings";
import { calDb } from "@/lib/calendar/db";
import { pageLocale } from "@/lib/page";
import { sql } from "@/lib/store";

export const dynamic = "force-dynamic";

// An invitation sent by e-mail (/cal/invite/<token>): what it is, and Yes /
// No / Maybe. The answer is a POST from this page (a letter's link only
// opens it: mail scanners that follow links never answer for anyone).

type Props = { params: Promise<{ token: string }> };

export async function generateMetadata(): Promise<Metadata> {
  return { title: calText(await pageLocale(), "inv.title"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

export default async function InviteRoute({ params }: Props) {
  const [{ token }, locale] = await Promise.all([params, pageLocale()]);
  let info: { title: string; when: string; location: string; rsvp: string } | null = null;
  if (/^[A-Za-z0-9_-]{20,64}$/.test(token)) {
    calDb();
    const att = sql("SELECT event_id, rsvp FROM cal_attendees WHERE token_hash = ?").get(tokenHash("cal-rsvp", token)) as { event_id: string; rsvp: string } | undefined;
    const ev = att ? eventRow(att.event_id) : null;
    if (att && ev && !ev.deleted_at) info = { title: ev.title, when: whenLine(ev, locale, ev.tz), location: ev.location, rsvp: att.rsvp };
  }
  return (
    <Messages ns="calendar" locale={locale} dict={messagesOf("calendar", locale)}>
      <InvitePage token={token} info={info} />
    </Messages>
  );
}
