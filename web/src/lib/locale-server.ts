// The interface language of a request from its cookie and Accept-Language
// (route handlers; pages use lib/page.ts).
import { parseAcceptLanguage, resolveLocale, UI_LANG_COOKIE, type Locale } from "./i18n";

export { parseAcceptLanguage };

export function readLocale(cookieHeader: string | null, languages: string[]): Locale {
  const m = (cookieHeader ?? "").match(new RegExp(`(?:^|;\\s*)${UI_LANG_COOKIE}=([a-z]{2})`));
  return resolveLocale(m?.[1], languages);
}
