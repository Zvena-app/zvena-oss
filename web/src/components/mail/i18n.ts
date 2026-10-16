"use client";

// Mail's words in the page's language (the dictionary is lib/mail-client/strings.ts:
// English and Russian there, the other languages from src/i18n/catalogs/mail/).

import { useCallback } from "react";
import { useI18n } from "@/lib/i18n-react";
import { mailText, type MailKey } from "@/lib/mail-client/strings";

export type MT = (key: MailKey, vars?: Record<string, string | number>) => string;

export function useMt(): { t: MT; locale: string } {
  const { locale } = useI18n();
  const t = useCallback<MT>((key, vars) => mailText(locale, key, vars), [locale]);
  return { t, locale };
}

/** For event handlers outside React (the page's <html lang>). */
export function mt(key: MailKey, vars?: Record<string, string | number>): string {
  const lang = typeof document !== "undefined" ? document.documentElement.lang || "en" : "en";
  return mailText(lang, key, vars);
}
