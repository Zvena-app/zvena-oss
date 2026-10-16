"use client";

// Calendar's words in the interface's language (lib/calendar/strings.ts);
// the page hands the browser its catalog through <Messages ns="calendar">.

import { useCallback } from "react";
import { useI18n } from "@/lib/i18n-react";
import { calText, type CalKey } from "@/lib/calendar/strings";

export type { CalKey };
export type CT = (key: CalKey, vars?: Record<string, string | number>) => string;

export function useCt(): { t: CT; locale: string } {
  const { locale } = useI18n();
  const t = useCallback<CT>((key, vars) => calText(locale, key, vars), [locale]);
  return { t, locale };
}
