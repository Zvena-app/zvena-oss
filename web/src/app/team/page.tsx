import type { Metadata } from "next";
import { AppShell } from "@/components/zvena/AppShell";
import { config } from "@/lib/config";
import { canInvite } from "@/lib/enterprise/security";
import { translate } from "@/lib/i18n";
import { requireUser, pageLocale } from "@/lib/page";
import { invitesOf, membersOf } from "@/lib/workspaces";
import { TeamPanel } from "./TeamPanel";

export async function generateMetadata(): Promise<Metadata> {
  return { title: translate(await pageLocale(), "nav.team"), robots: { index: false, follow: false } };
}

type Props = { searchParams: Promise<{ ws?: string; team?: string; new?: string }> };

export default async function TeamPage({ searchParams }: Props) {
  const sp = await searchParams;
  const { user, locale } = await requireUser("/team", sp.ws, sp.team);
  const t = (k: Parameters<typeof translate>[1]) => translate(locale, k);
  const ws = user.ws;
  return (
    <AppShell user={user} section="team" title={t("nav.team")} aside={ws.name}>
      <div className="zv-content zv-content-narrow">
        <TeamPanel
          me={user.id}
          ws={ws}
          members={membersOf(ws.id)}
          invites={ws.role === "owner" ? invitesOf(ws.id) : []}
          inviteDays={config.inviteDays}
          startNew={sp.new === "1"}
          canInvite={!ws.personal && canInvite(user.id, ws.id)}
        />
      </div>
    </AppShell>
  );
}
