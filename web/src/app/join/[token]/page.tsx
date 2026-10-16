import type { Metadata } from "next";
import { translate } from "@/lib/i18n";
import { pageUser } from "@/lib/page";
import { previewInvite } from "@/lib/workspaces";
import { PublicFooter, PublicHeader } from "@/components/zvena/PublicChrome";
import { JoinButton } from "./JoinButton";

export const metadata: Metadata = { title: "Invitation", robots: { index: false, follow: false } };

type Props = { params: Promise<{ token: string }> };

export default async function JoinPage({ params }: Props) {
  const { token } = await params;
  const { user, locale } = await pageUser();
  const t = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate(locale, k, v);
  const inv = previewInvite(token);
  return (
    <>
      <PublicHeader locale={locale} signedIn={Boolean(user)} />
      <main className="zv-center">
        <div className="zv-panel">
          {!inv ? (
            <>
              <h1>{t("nav.team")}</h1>
              <p className="zv-lead">{t("join.invalid")}</p>
            </>
          ) : (
            <>
              <h1>{t("join.title", { name: inv.wsName })}</h1>
              <p className="zv-lead">{t("join.lead", { role: t(`ws.role.${inv.role}`), members: inv.members })}</p>
              {user ? (
                <JoinButton token={token} label={t("join.accept")} />
              ) : (
                <a className="zv-btn zv-btn-primary zv-btn-lg zv-btn-block" href={`/signin?next=${encodeURIComponent(`/join/${token}`)}`}>
                  {t("join.signin")}
                </a>
              )}
            </>
          )}
        </div>
      </main>
      <PublicFooter locale={locale} />
    </>
  );
}
