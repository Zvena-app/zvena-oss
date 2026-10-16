// The interface language's cookie: shared by the app and Design. Pure and
// dictionary-free, so the root layout's client code can use it (lib/i18n.ts
// re-exports it).

import type { Locale } from "@/i18n/locales";

export const UI_LANG_COOKIE = "zv_lang";

/**
 * The domain the language cookie is shared on: example.com for example.com and its
 * subdomains (Design on design.example.com reads it too), none for localhost or an IP.
 */
export function langCookieDomain(host: string): string | null {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  if (h === "localhost" || /^[\d.]+$/.test(h) || h.includes(":") || !h.includes(".")) return null;
  return h.split(".").slice(-2).join(".");
}

/** Remembers the interface language (browser only): one cookie for the app and Design. */
export function writeLangCookie(l: Locale): void {
  const domain = langCookieDomain(location.hostname);
  const secure = location.protocol === "https:" ? "; Secure" : "";
  const cookie = `${UI_LANG_COOKIE}=${l}; Path=/; Max-Age=${400 * 86400}; SameSite=Lax${secure}`;
  if (domain) {
    // A host-only cookie from before would shadow the shared one: drop it.
    document.cookie = `${UI_LANG_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
    document.cookie = `${cookie}; Domain=${domain}`;
    if (new RegExp(`(?:^|;\\s*)${UI_LANG_COOKIE}=${l}(?:;|$)`).test(document.cookie)) return;
    // The browser refused the domain (a public suffix such as co.uk on a self-hosted
    // install): keep the language on this host at least.
  }
  document.cookie = cookie;
}
