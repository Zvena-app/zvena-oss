"use client";

import { useCallback, useContext } from "react";
import { translate, type Locale, type MessageKey } from "./i18n";
import { I18nContext } from "./i18n-provider";

// The provider lives in lib/i18n-provider.tsx (no dictionary in it); this
// module adds t(), which needs lib/i18n.ts's dictionaries.
export { I18nProvider } from "./i18n-provider";

export type TFunction = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function useI18n(): { t: TFunction; locale: Locale; setLocale: (l: Locale) => void } {
  const { locale, setLocale } = useContext(I18nContext);
  const t = useCallback<TFunction>((key, vars) => translate(locale, key, vars), [locale]);
  return { t, locale, setLocale };
}
