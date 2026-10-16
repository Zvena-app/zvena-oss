import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { translate, type MessageKey } from "@/lib/i18n";
import { safeNext } from "@/lib/safe-next";
import { pageUser } from "@/lib/page";
import { PublicFooter, PublicHeader } from "@/components/zvena/PublicChrome";
import { TermsNote } from "@/components/zvena/TermsNote";

export const metadata: Metadata = { title: "Sign in with SSO", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ next?: string; email?: string }> };

// "Continue with SSO": a work address picks the workspace by its verified
// domain and goes to that workspace's identity provider (app/api/sso/start).
// The form sits next to "By continuing, you agree to the Terms…".
export default async function SsoSignInPage({ searchParams }: Props) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  const { user, locale } = await pageUser();
  if (user) redirect(next);
  const t = (k: MessageKey) => translate(locale, k);
  return (
    <>
      <PublicHeader locale={locale} signedIn={false} />
      <main className="zv-center">
        <div className="zv-panel">
          <h1>{t("signin.ssoTitle")}</h1>
          <p className="zv-lead">{t("signin.ssoLead")}</p>
          <form method="get" action="/api/sso/start" className="zv-stack">
            <input type="hidden" name="next" value={next} />
            <label className="zv-field" style={{ margin: 0 }}>
              <span className="zv-sr">{t("signin.emailLabel")}</span>
              <input
                className="zv-input zv-input-lg"
                type="email"
                name="email"
                required
                maxLength={254}
                autoComplete="email"
                inputMode="email"
                placeholder={t("signin.emailPlaceholder")}
                defaultValue={typeof sp.email === "string" ? sp.email.slice(0, 254) : ""}
                aria-label={t("signin.emailLabel")}
                autoFocus
              />
            </label>
            <button type="submit" className="zv-btn zv-btn-primary zv-btn-lg zv-btn-block">
              {t("signin.ssoContinue")}
            </button>
            <TermsNote />
          </form>
          <p className="zv-small" style={{ marginTop: 16, textAlign: "center" }}>
            <Link href={`/signin?next=${encodeURIComponent(next)}`}>{t("signin.otherWays")}</Link>
          </p>
        </div>
      </main>
      <PublicFooter locale={locale} />
    </>
  );
}
