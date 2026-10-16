import { cookieSecure, readCookie } from "@/lib/auth";
import { currentUser, json } from "@/lib/http";
import { resolveLocale, parseAcceptLanguage, translate, UI_LANG_COOKIE } from "@/lib/i18n";
import { rateLimited } from "@/lib/rate-limit";
import { sessionUser, WS_COOKIE, wsCookie } from "@/lib/session";
import { rememberUserLocale } from "@/lib/user-locale";

export const dynamic = "force-dynamic";

// GET /api/auth/session?ws=<id> → { user: { id, name, ws, workspaces, isAdmin } | null }
// Refreshes (and rotates) the session cookie; remembers the open workspace.
export async function GET(req: Request) {
  const rl = rateLimited(req, "auth-session");
  if (rl) return rl;
  const me = currentUser(req);
  if (!me) return json({ user: null });
  const locale = resolveLocale(readCookie(req, UI_LANG_COOKIE), parseAcceptLanguage(req.headers.get("accept-language")));
  // What the server writes to this person later (Inbox items, letters) speaks their language.
  rememberUserLocale(me.user.id, locale);
  const user = sessionUser(me.user, new URL(req.url).searchParams.get("ws"), readCookie(req, WS_COOKIE), translate(locale, "ws.personal"));
  const headers = new Headers({ "cache-control": "private, no-store", "content-type": "application/json" });
  if (me.setCookie) headers.append("set-cookie", me.setCookie);
  headers.append("set-cookie", wsCookie(user.ws.id, cookieSecure()));
  return new Response(JSON.stringify({ user }), { headers });
}
