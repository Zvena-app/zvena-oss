import type { Metadata } from "next";
import { AppShell } from "@/components/zvena/AppShell";
import { InboxView } from "@/components/eco/InboxView";
import { translate } from "@/lib/i18n";
import { requireUser, pageLocale } from "@/lib/page";

export async function generateMetadata(): Promise<Metadata> {
  return { title: translate(await pageLocale(), "nav.inbox"), robots: { index: false, follow: false } };
}

type Props = { searchParams: Promise<{ ws?: string; team?: string }> };

// One Inbox for every product: mentions in documents, issues assigned,
// comments, reminders — newest first, read and archived in one place.
export default async function InboxPage({ searchParams }: Props) {
  const sp = await searchParams;
  const { user, locale } = await requireUser("/inbox", sp.ws, sp.team);
  return (
    <AppShell user={user} section="inbox" title={translate(locale, "nav.inbox")} aside={user.ws.name}>
      <div className="zv-content zv-content-narrow">
        <InboxView ws={user.ws.id} me={user.id} />
      </div>
    </AppShell>
  );
}
