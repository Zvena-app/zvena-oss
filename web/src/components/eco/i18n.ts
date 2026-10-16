"use client";

// The ecosystem's words, in the languages of the interface. Kept here (not in
// lib/i18n.ts) so the components can live on any surface: Home, Documents,
// Projects. The language is the page's <html lang>.

import { useCallback } from "react";
import { useI18n } from "@/lib/i18n-react";
import { ecoText, type EcoKey } from "@/lib/eco/strings";
import { isLocale, type Locale } from "@/i18n/locales";

export type { EcoKey };

/** The page's language (event handlers; while rendering use useI18n()). */
export function ecoLocale(): Locale {
  const lang = typeof document !== "undefined" ? document.documentElement.lang : "";
  return isLocale(lang) ? lang : "en";
}

export function et(key: EcoKey, vars?: Record<string, string | number>): string {
  return ecoText(ecoLocale(), key, vars);
}

/**
 * The words in the page's language, the same on the server and in the browser
 * (the language comes from the app's I18nProvider, not from <html lang>, which
 * the server render cannot read). Use it while rendering; et() is for event
 * handlers, which only run in the browser.
 */
export function useEt(): (key: EcoKey, vars?: Record<string, string | number>) => string {
  const { locale } = useI18n();
  return useCallback((key: EcoKey, vars?: Record<string, string | number>) => ecoText(locale, key, vars), [locale]);
}
