import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { MailCheck } from "lucide-react";
import { maskEmail, peekRef } from "@/lib/email-signin";
import { translate, type MessageKey } from "@/lib/i18n";
import { pageUser } from "@/lib/page";
import { PublicFooter, PublicHeader } from "@/components/zvena/PublicChrome";

export const metadata: Metadata = { title: "Check your inbox", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ r?: string; error?: string }> };

// After "Continue with e-mail": where the letter went (masked), and a field
// for the 6-digit code for when the letter is opened on another device.
export default async function CheckEmailPage({ searchParams }: Props) {
  const sp = await searchParams;
  const { user, locale } = await pageUser();
  if (user) redirect("/home");
  const t = (k: MessageKey, v?: Record<string, string>) => translate(locale, k, v);
  const live = peekRef(sp.r);
  return (
    <>
      <PublicHeader locale={locale} signedIn={false} />
      <main className="zv-center">
        <div className="zv-panel">
          <div className="zv-panel-icon">
            <MailCheck />
          </div>
          <h1>{t("checkEmail.title")}</h1>
          {live ? (
            <>
              <p className="zv-lead">{t("checkEmail.lead", { email: maskEmail(live.email) })}</p>
              {sp.error === "wrong-code" && (
                <p className="zv-banner zv-banner-error" role="alert" style={{ marginBottom: 16 }}>
                  {t("checkEmail.wrongCode")}
                </p>
              )}
              <form method="post" action="/api/auth/email/verify" className="zv-stack">
                <input type="hidden" name="ref" value={sp.r} />
                <label className="zv-field" style={{ margin: 0 }}>
                  <span className="zv-label">{t("checkEmail.code")}</span>
                  <input
                    className="zv-input zv-input-lg zv-code-input"
                    name="code"
                    required
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="\s*\d{3}\s*\d{3}\s*"
                    maxLength={9}
                    placeholder="123456"
                  />
                </label>
                <button type="submit" className="zv-btn zv-btn-primary zv-btn-lg zv-btn-block">
                  {t("checkEmail.submit")}
                </button>
              </form>
              <p className="zv-muted zv-small" style={{ textAlign: "center", margin: "18px 0 0" }}>
                {t("checkEmail.hint")}
              </p>
            </>
          ) : (
            <p className="zv-banner zv-banner-warn">{t("checkEmail.expired")}</p>
          )}
          <div className="zv-actions" style={{ justifyContent: "center", marginTop: 14 }}>
            <Link className="zv-btn zv-btn-ghost zv-btn-sm" href="/signin">
              {live ? t("checkEmail.again") : t("emailLink.newLink")}
            </Link>
            {live && (
              <Link className="zv-btn zv-btn-ghost zv-btn-sm" href="/signin">
                {t("checkEmail.other")}
              </Link>
            )}
          </div>
        </div>
      </main>
      <PublicFooter locale={locale} />
    </>
  );
}
