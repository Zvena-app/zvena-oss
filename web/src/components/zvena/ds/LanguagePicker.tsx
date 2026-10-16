"use client";

// The interface language, from anywhere: the rail's footer and the public
// site. The choice is a cookie (zv_lang, read by the server for the first
// paint, shared with Design on Domain=zvena.app); the page reloads in the new language.

import { Globe } from "lucide-react";
import { writeLangCookie } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-react";
import { LOCALES, LOCALE_INFO, type Locale } from "@/i18n/locales";
import "./ds.css";

export function setLanguage(l: Locale): void {
  writeLangCookie(l);
  location.reload();
}

/** `compact`: the globe and the language's code (EN, 中…), for the rail's footer; the list still shows native names. */
export function LanguagePicker({ label = "Language", compact = false }: { label?: string; compact?: boolean }) {
  const { locale } = useI18n();
  return (
    <label className="ds-lang" data-compact={compact || undefined} title={`${label}: ${LOCALE_INFO[locale as Locale]?.native ?? locale}`}>
      <Globe aria-hidden />
      {compact && <span className="ds-lang-code" aria-hidden>{locale.toUpperCase()}</span>}
      <select aria-label={label} value={locale} onChange={(e) => setLanguage(e.target.value as Locale)}>
        {LOCALES.map((l) => (
          <option key={l} value={l} lang={l}>
            {LOCALE_INFO[l].native}
          </option>
        ))}
      </select>
    </label>
  );
}
