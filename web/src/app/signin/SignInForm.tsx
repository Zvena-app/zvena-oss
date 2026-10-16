"use client";

// The ways in: Google, GitHub and a one-time e-mail link (each shown only
// when its keys are set), the test sign-in on a test stand, and the Terms
// line every one of them sits next to.

import { useState } from "react";
import { KeyRound, Mail } from "lucide-react";
import { GitHubIcon, GoogleIcon } from "@/components/zvena/BrandIcons";
import { TermsNote } from "@/components/zvena/TermsNote";
import { useI18n } from "@/lib/i18n-react";

export interface Providers {
  google: boolean;
  github: boolean;
  email: boolean;
  dev: boolean;
}

export function SignInForm({ providers, next, email: initialEmail = "" }: { providers: Providers; next: string; email?: string }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const href = (p: "google" | "github") => `/api/auth/start?provider=${p}&next=${encodeURIComponent(next)}`;
  const none = !providers.google && !providers.github && !providers.email && !providers.dev;
  return (
    <div className="zv-stack">
      {providers.google && (
        <a className="zv-btn zv-btn-lg zv-btn-block zv-btn-provider" href={href("google")}>
          <GoogleIcon />
          {t("signin.google")}
        </a>
      )}
      {providers.github && (
        <a className="zv-btn zv-btn-lg zv-btn-block zv-btn-provider" href={href("github")}>
          <GitHubIcon />
          {t("signin.github")}
        </a>
      )}
      {/* A workspace's identity provider, found by the work address (app/signin/sso). */}
      <a className="zv-btn zv-btn-lg zv-btn-block zv-btn-provider" href={`/signin/sso?next=${encodeURIComponent(next)}`}>
        <KeyRound />
        {t("signin.sso")}
      </a>
      {providers.email && (
        <div className="zv-or" role="separator">
          <span>{t("signin.or")}</span>
        </div>
      )}
      {providers.email && (
        <form method="post" action="/api/auth/email/start" className="zv-stack" onSubmit={() => setBusy(true)}>
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
              defaultValue={initialEmail}
              aria-label={t("signin.emailLabel")}
            />
          </label>
          <button type="submit" className="zv-btn zv-btn-primary zv-btn-lg zv-btn-block" disabled={busy}>
            <Mail />
            {t("signin.email")}
          </button>
        </form>
      )}
      {providers.dev && (
        <form method="post" action="/api/auth/dev" className="zv-stack zv-dev-signin">
          <input type="hidden" name="next" value={next} />
          <label className="zv-field" style={{ marginBottom: 0 }}>
            <span className="zv-label">{t("signin.devName")}</span>
            <input className="zv-input" name="name" defaultValue="Test User" maxLength={60} autoComplete="off" />
          </label>
          <button type="submit" className="zv-btn zv-btn-block">
            {t("signin.dev")}
          </button>
        </form>
      )}
      {none ? (
        <p className="zv-banner">
          {t("signin.noProviders")} <a href="/docs">{t("footer.tryDocs")}</a>
        </p>
      ) : (
        <TermsNote />
      )}
    </div>
  );
}

/** Agreeing to the new Terms version (the /consent page). */
export function ReconsentForm({ next }: { next: string }) {
  const { t } = useI18n();
  return (
    <form method="post" action="/api/auth/consent" className="zv-stack">
      <input type="hidden" name="next" value={next} />
      <input type="hidden" name="consent" value="1" />
      <p className="zv-muted zv-small" style={{ margin: "0 0 6px", textAlign: "center" }}>
        <a href="/legal/terms" target="_blank" rel="noopener">
          {t("signin.termsLink")}
        </a>
        {" · "}
        <a href="/legal/privacy" target="_blank" rel="noopener">
          {t("signin.privacyLink")}
        </a>
      </p>
      <button type="submit" className="zv-btn zv-btn-primary zv-btn-lg zv-btn-block">
        {t("consent.continue")}
      </button>
      <button
        type="button"
        className="zv-btn zv-btn-block"
        onClick={() => void fetch("/api/auth/logout", { method: "POST" }).finally(() => window.location.assign("/"))}
      >
        {t("consent.signout")}
      </button>
    </form>
  );
}
