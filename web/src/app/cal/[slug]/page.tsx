import type { Metadata } from "next";
import { BookingPage, Missing } from "@/components/calendar/booking/BookingPage";
import { Messages } from "@/i18n/Messages";
import { messagesOf } from "@/i18n/runtime";
import { bookingPage, publicLink } from "@/lib/calendar/booking";
import { calText } from "@/lib/calendar/strings";
import { pageLocale } from "@/lib/page";

export const dynamic = "force-dynamic";

// A scheduling link's public page (/cal/<slug>): works signed out and is
// rendered on the server with the link's own words and the first free
// times. Only what the host chose to show is here — their name, the link's
// title, length and place — never anything about the host's other events.

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const [{ slug }, locale] = await Promise.all([params, pageLocale()]);
  const link = publicLink(slug);
  return {
    title: link ? `${link.row.title} · ${link.hostName}` : calText(locale, "book.notFound"),
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

export default async function CalLinkPage({ params }: Props) {
  const [{ slug }, locale] = await Promise.all([params, pageLocale()]);
  const data = bookingPage(slug);
  if (!data) return <Missing text={calText(locale, "book.notFound")} />;
  return (
    <Messages ns="calendar" locale={locale} dict={messagesOf("calendar", locale)}>
      <BookingPage now={data.now} initialSlots={data.slots} link={data.link} />
    </Messages>
  );
}
