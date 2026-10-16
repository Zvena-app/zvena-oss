"use client";

// The interface language for client components: the provider the root layout
// renders on every page. It imports no dictionary (lib/i18n.ts holds the
// English and Russian ones), so pages whose client code never translates —
// the English-only website — don't download them; useI18n() in
// lib/i18n-react.tsx brings the dictionary where it is used.

import { createContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Locale } from "@/i18n/locales";
import { langCookieDomain, UI_LANG_COOKIE, writeLangCookie } from "./lang-cookie";
import { registerAll } from "@/i18n/Messages";
import type { Dict, Namespace } from "@/i18n/runtime";

export interface I18nState {
  locale: Locale;
  setLocale: (l: Locale) => void;
}

export const I18nContext = createContext<I18nState>({ locale: "en", setLocale: () => {} });

/**
 * Interface language: resolved on the server so the first paint is in the
 * right language. `messages` are the page language's translations of the
 * shared namespaces (web, eco, ds) for every language but English and
 * Russian, which live in the code.
 */
export function I18nProvider({ initialLocale, messages, children }: { initialLocale: Locale; messages?: Partial<Record<Namespace, Dict>>; children: ReactNode }) {
  // Before anything renders: the browser's registry gets the page's language.
  useState(() => {
    if (messages) registerAll(initialLocale, messages);
    return null;
  });
  const [locale, setLocale] = useState<Locale>(initialLocale);
  // A language chosen before the cookie was shared with Design (host-only, so
  // design.example.com never saw it) is written again, shared, once a session.
  useEffect(() => {
    try {
      if (!langCookieDomain(location.hostname) || sessionStorage.getItem("zv-lang-shared")) return;
      sessionStorage.setItem("zv-lang-shared", "1");
    } catch {
      return;
    }
    if (new RegExp(`(?:^|;\\s*)${UI_LANG_COOKIE}=${initialLocale}(?:;|$)`).test(document.cookie)) writeLangCookie(initialLocale);
  }, [initialLocale]);
  const value = useMemo(() => ({ locale, setLocale }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
