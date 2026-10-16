import type { Metadata, Viewport } from "next";
import { MailApp } from "@/components/mail/MailApp";
import { Messages } from "@/i18n/Messages";
import { messagesOf } from "@/i18n/runtime";
import { mailText } from "@/lib/mail-client/strings";
import { pageLocale, requireUser } from "@/lib/page";

export async function generateMetadata(): Promise<Metadata> {
  return { title: mailText(await pageLocale(), "app.name"), robots: { index: false, follow: false } };
}

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", interactiveWidget: "resizes-content" };

// zvena Mail: the person's own mailboxes inside zvena's frame. One page for
// every /mail/... address (a view, a label, a search, a conversation,
// settings): the app reads the place from the URL (src/components/mail).

type Props = { params: Promise<{ path?: string[] }>; searchParams: Promise<{ ws?: string; team?: string; t?: string; q?: string }> };

export default async function MailPage({ params, searchParams }: Props) {
  const [{ path }, sp] = await Promise.all([params, searchParams]);
  const q = new URLSearchParams(Object.entries(sp).filter((e): e is [string, string] => typeof e[1] === "string")).toString();
  const here = `/mail${path?.length ? `/${path.map(encodeURIComponent).join("/")}` : ""}${q ? `?${q}` : ""}`;
  const { user, locale } = await requireUser(here, sp.ws, sp.team);
  // Mail's words in the page's language (English and Russian live in the code).
  return (
    <Messages ns="mail" locale={locale} dict={messagesOf("mail", locale)}>
      <MailApp user={user} />
    </Messages>
  );
}
