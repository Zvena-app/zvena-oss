import type { Metadata } from "next";
import { BookingPage, Missing } from "@/components/calendar/booking/BookingPage";
import { Messages } from "@/i18n/Messages";
import { messagesOf } from "@/i18n/runtime";
import { managePage } from "@/lib/calendar/booking";
import { calText } from "@/lib/calendar/strings";
import { pageLocale } from "@/lib/page";

export const dynamic = "force-dynamic";

// A guest's own booking (/cal/<slug>/<token>, the link in their letter):
// reschedule it to another free time, or cancel it. The token is the proof;
// only its HMAC is stored.

type Props = { params: Promise<{ slug: string; token: string }> };

export async function generateMetadata(): Promise<Metadata> {
  return { title: calText(await pageLocale(), "book.manage"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

export default async function ManageBookingPage({ params }: Props) {
  const [{ slug, token }, locale] = await Promise.all([params, pageLocale()]);
  const data = managePage(slug, token);
  if (!data) return <Missing text={calText(locale, "inv.notFound")} />;
  return (
    <Messages ns="calendar" locale={locale} dict={messagesOf("calendar", locale)}>
      <BookingPage now={data.now} initialSlots={data.slots} link={data.link} managed={data.managed} />
    </Messages>
  );
}
