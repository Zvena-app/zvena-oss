// Time as people read it in the shared components. Pure (tests use it).

import { intlTag, isLocale } from "@/i18n/locales";

/** "5 min ago", "yesterday", "14 Oct" in the interface's language. */
export function relativeTime(at: number, locale: string, now = Date.now()): string {
  const tag = isLocale(locale) ? intlTag(locale) : "en-US";
  const s = Math.round((now - at) / 1000);
  const rtf = new Intl.RelativeTimeFormat(tag, { numeric: "auto" });
  if (s < 45) return rtf.format(0, "second");
  if (s < 3600) return rtf.format(-Math.round(s / 60), "minute");
  if (s < 86400) return rtf.format(-Math.round(s / 3600), "hour");
  if (s < 7 * 86400) return rtf.format(-Math.round(s / 86400), "day");
  return new Date(at).toLocaleDateString(tag, { day: "numeric", month: "short" });
}
