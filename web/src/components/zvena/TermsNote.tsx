"use client";

// "By continuing, you agree to the Terms of Service and acknowledge the
// Privacy Policy." — shown next to every way to sign in (the buttons, the
// e-mail form and Google One Tap), so pressing one accepts the Terms version
// in force (config.consentVersion), which the server records. Server pages
// can render TermsNoteView with server-side strings instead.

import { useI18n } from "@/lib/i18n-react";
import { TERMS_MARKS, TermsNoteView } from "./TermsNoteView";

export function TermsNote({ which = "signin.terms", className = "zv-terms" }: { which?: "signin.terms" | "landing.terms"; className?: string }) {
  const { t } = useI18n();
  return <TermsNoteView text={t(which, TERMS_MARKS)} termsLink={t("signin.termsLink")} privacyLink={t("signin.privacyLink")} className={className} />;
}
