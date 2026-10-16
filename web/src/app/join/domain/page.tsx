import type { Metadata } from "next";
import { joinableWorkspaces } from "@/lib/enterprise/join";
import { translate } from "@/lib/i18n";
import { safeNext } from "@/lib/safe-next";
import { requireUser } from "@/lib/page";
import { PublicFooter, PublicHeader } from "@/components/zvena/PublicChrome";
import { JoinDomainList } from "./JoinDomainList";

export const metadata: Metadata = { title: "Join your team", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ next?: string }> };

// Right after signing in (lib/signin.ts): the workspaces the person's e-mail
// domain lets them join ("Allowed e-mail domains", lib/enterprise/join.ts).
export default async function JoinDomainPage({ searchParams }: Props) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  const { user, locale } = await requireUser(`/join/domain?next=${encodeURIComponent(next)}`);
  const t = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate(locale, k, v);
  const list = joinableWorkspaces(user.id);
  return (
    <>
      <PublicHeader locale={locale} signedIn />
      <main className="zv-center">
        <div className="zv-panel">
          <h1>{t("joinDomain.title")}</h1>
          <p className="zv-lead">{list.length ? t("joinDomain.lead") : t("joinDomain.none")}</p>
          <JoinDomainList workspaces={list.map((w) => ({ id: w.id, name: w.name, meta: t("joinDomain.members", { n: w.members, domain: w.domain }) }))} next={next} />
        </div>
      </main>
      <PublicFooter locale={locale} />
    </>
  );
}
