// Server-only helpers for pages: the request's language and the signed-in
// person (pages that need an account send guests to sign in).

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { readSession } from "./auth";
import { parseAcceptLanguage, resolveLocale, translate, UI_LANG_COOKIE, type Locale } from "./i18n";
import { sessionUser, WS_COOKIE, type SessionUser } from "./session";

export async function pageLocale(): Promise<Locale> {
  const [c, h] = await Promise.all([cookies(), headers()]);
  return resolveLocale(c.get(UI_LANG_COOKIE)?.value, parseAcceptLanguage(h.get("accept-language")));
}

/** The signed-in person with the open workspace, or null. */
export async function pageUser(wantWs?: string | null, team?: string | null): Promise<{ user: SessionUser | null; locale: Locale }> {
  const [c, h] = await Promise.all([cookies(), headers()]);
  const locale = resolveLocale(c.get(UI_LANG_COOKIE)?.value, parseAcceptLanguage(h.get("accept-language")));
  const u = readSession(h.get("cookie"));
  if (!u) return { user: null, locale };
  return { user: sessionUser(u, wantWs ?? null, c.get(WS_COOKIE)?.value, translate(locale, "ws.personal"), team), locale };
}

/** Like pageUser, but a guest goes to the sign-in page and comes back to `here`;
 * someone who has not agreed to the current consent text agrees first. */
export async function requireUser(here: string, wantWs?: string | null, team?: string | null): Promise<{ user: SessionUser; locale: Locale }> {
  const { user, locale } = await pageUser(wantWs, team);
  if (!user) redirect(`/signin?next=${encodeURIComponent(here)}`);
  if (!user.consentOk) redirect(`/consent?next=${encodeURIComponent(here)}`);
  return { user, locale };
}
