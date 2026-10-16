import type { Metadata } from "next";
import { pageMetadata } from "@/lib/meta";
import { redirect } from "next/navigation";
import { authStatus } from "@/lib/auth";
import { config } from "@/lib/config";
import { translate, type MessageKey } from "@/lib/i18n";
import { safeNext } from "@/lib/oauth";
import { pageUser } from "@/lib/page";
import { GoogleOneTap } from "@/components/zvena/GoogleOneTap";
import { PublicFooter, PublicHeader } from "@/components/zvena/PublicChrome";
import { SignInForm } from "./SignInForm";

export const metadata: Metadata = pageMetadata({ title: "Sign in", description: "Sign in to zvena with Google, GitHub or a one-time email link. No password needed.", path: "/signin", robots: { index: false, follow: true } });

type Props = { searchParams: Promise<{ next?: string; error?: string }> };

const ERRORS: Record<string, MessageKey> = {
  "consent-required": "signin.consentRequired",
  blocked: "signin.blocked",
  denied: "signin.denied",
  state: "signin.state",
  provider: "signin.provider",
  "email-invalid": "signin.emailInvalid",
  "email-too-many": "signin.emailTooMany",
  "email-failed": "signin.emailFailed",
  "email-expired": "signin.emailExpired",
  // Single sign-on (lib/enterprise/sso.ts).
  "sso-required": "signin.ssoRequired",
  "sso-failed": "signin.ssoFailed",
  "sso-unknown": "signin.ssoUnknown",
  "sso-domain": "signin.ssoDomain",
  "sso-not-member": "signin.ssoNotMember",
  "sso-limit": "signin.ssoLimit",
};

export default async function SignInPage({ searchParams }: Props) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  const { user, locale } = await pageUser();
  if (user) redirect(next);
  const t = (k: MessageKey) => translate(locale, k);
  const error = sp.error ? t(ERRORS[sp.error] ?? "signin.failed") : null;
  const providers = authStatus();
  return (
    <>
      <PublicHeader locale={locale} signedIn={false} />
      <main className="zv-center">
        <div className="zv-panel">
          <h1>{t("signin.title")}</h1>
          <p className="zv-lead">{t("signin.lead")}</p>
          {config.isTestStand && (
            <p className="zv-banner zv-banner-warn" style={{ marginBottom: 16 }}>
              {t("signin.testStand")}
            </p>
          )}
          {error && (
            <p className="zv-banner zv-banner-error" role="alert" style={{ marginBottom: 16 }}>
              {error}
            </p>
          )}
          <SignInForm providers={{ google: providers.google, github: providers.github, email: providers.email, dev: providers.dev }} next={next} />
        </div>
      </main>
      {providers.google && <GoogleOneTap clientId={providers.googleClientId} next={next} />}
      <PublicFooter locale={locale} />
    </>
  );
}
