import type { Metadata } from "next";
import { translate } from "@/lib/i18n";
import { pageUser } from "@/lib/page";
import { previewPageInvite } from "@/lib/notes/page-invites";
import { iconText } from "@/lib/notes/model";
import { notesT } from "@/lib/notes/i18n";
import { PublicFooter, PublicHeader } from "@/components/zvena/PublicChrome";
import { AcceptPageInvite } from "./AcceptPageInvite";

export const metadata: Metadata = { title: "Invitation", robots: { index: false, follow: false } };

type Props = { params: Promise<{ token: string }> };

// A page invite link (Share → "Invite" for people outside the workspace).
export default async function SharePage({ params }: Props) {
  const { token } = await params;
  const { user, locale } = await pageUser();
  const t = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate(locale, k, v);
  const inv = previewPageInvite(token);
  const title = inv ? `${iconText(inv.icon) ? `${iconText(inv.icon)} ` : ""}${inv.title || notesT(locale, "page.untitled")}` : "";
  return (
    <>
      <PublicHeader locale={locale} signedIn={Boolean(user)} />
      <main className="zv-center">
        <div className="zv-panel">
          {!inv ? (
            <>
              <h1>{t("nav.docs")}</h1>
              <p className="zv-lead">{t("join.invalid")}</p>
            </>
          ) : (
            <>
              <h1>{t("pageInvite.title", { title })}</h1>
              <p className="zv-lead">{t("pageInvite.lead", { ws: inv.wsName, level: t(`pageInvite.level.${inv.level}`) })}</p>
              {user ? (
                <AcceptPageInvite token={token} label={t("pageInvite.open")} />
              ) : (
                <a className="zv-btn zv-btn-primary zv-btn-lg zv-btn-block" href={`/signin?next=${encodeURIComponent(`/share/${token}`)}`}>
                  {t("pageInvite.signin")}
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
