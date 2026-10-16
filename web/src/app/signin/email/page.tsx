import type { Metadata } from "next";
import Link from "next/link";
import { peekLink } from "@/lib/email-signin";
import { translate, type MessageKey } from "@/lib/i18n";
import { pageUser } from "@/lib/page";
import { PublicFooter, PublicHeader } from "@/components/zvena/PublicChrome";
import { Email } from "@/components/zvena/Email";

export const metadata: Metadata = { title: "Sign in", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ token?: string }> };

// The link from the sign-in e-mail. Opening it does not sign in by itself
// (mail scanners open links too): the person presses "Continue", which posts
// the token once.
export default async function EmailLinkPage({ searchParams }: Props) {
  const { token } = await searchParams;
  const { user, locale } = await pageUser();
  const t = (k: MessageKey, v?: Record<string, string>) => translate(locale, k, v);
  const live = user ? null : peekLink(token);
  return (
    <>
      <PublicHeader locale={locale} signedIn={Boolean(user)} />
      <main className="zv-center">
        <div className="zv-panel">
          {live ? (
            <>
              <h1>{t("emailLink.title")}</h1>
              <p className="zv-lead">
                {t("emailLink.lead", { email: "\u0000" }).split("\u0000")[0]}
                <Email address={live.email} link={false} />
                {t("emailLink.lead", { email: "\u0000" }).split("\u0000")[1]}
              </p>
              <form method="post" action="/api/auth/email/verify" className="zv-stack">
                <input type="hidden" name="token" value={token} />
                <button type="submit" className="zv-btn zv-btn-primary zv-btn-lg zv-btn-block" autoFocus>
                  {t("emailLink.continue")}
                </button>
              </form>
            </>
          ) : user ? (
            <>
              <h1>{t("emailLink.title")}</h1>
              <div className="zv-actions" style={{ justifyContent: "center" }}>
                <Link className="zv-btn zv-btn-primary zv-btn-lg" href="/home">
                  {t("nav.home")}
                </Link>
              </div>
            </>
          ) : (
            <>
              <h1>{t("emailLink.expiredTitle")}</h1>
              <p className="zv-lead">{t("emailLink.expiredLead")}</p>
              <div className="zv-actions" style={{ justifyContent: "center" }}>
                <Link className="zv-btn zv-btn-primary zv-btn-lg" href="/signin">
                  {t("emailLink.newLink")}
                </Link>
              </div>
            </>
          )}
        </div>
      </main>
      <PublicFooter locale={locale} />
    </>
  );
}
