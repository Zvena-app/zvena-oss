import { readCookie, signInWith } from "@/lib/auth";
import { parseAcceptLanguage, resolveLocale, translate, UI_LANG_COOKIE } from "@/lib/i18n";
import { clearOAuthBindCookie, consumeState, exchange, isOAuthProvider, OAUTH_COOKIE } from "@/lib/oauth";
import { rateLimited } from "@/lib/rate-limit";
import { finishSignIn, signInError } from "@/lib/signin";

export const dynamic = "force-dynamic";

// GET /api/auth/callback/google|github?code=…&state=… — back from the provider.
export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const res = await callback(req, ctx);
  // The binding cookie has done its job, whatever the outcome.
  res.headers.append("set-cookie", clearOAuthBindCookie());
  return res;
}

async function callback(req: Request, { params }: { params: Promise<{ provider: string }> }): Promise<Response> {
  const rl = rateLimited(req, "auth-callback");
  if (rl) return rl;
  const { provider } = await params;
  if (!isOAuthProvider(provider)) return signInError("provider", "/home");
  const url = new URL(req.url);
  // Only the browser that started this sign-in may finish it (login CSRF).
  const st = consumeState(url.searchParams.get("state"), provider, readCookie(req, OAUTH_COOKIE));
  if (!st) return signInError("state", "/home");
  if (url.searchParams.get("error")) return signInError("denied", st.next);
  const profile = await exchange(provider, url.searchParams, st);
  if (!profile) return signInError("failed", st.next);
  const result = signInWith(profile, st.consent);
  if (!result.ok) return signInError(result.error, st.next);
  const locale = resolveLocale(readCookie(req, UI_LANG_COOKIE), parseAcceptLanguage(req.headers.get("accept-language")));
  return finishSignIn(result.user, { next: st.next, guest: st.guest, isNew: result.isNew, personalName: translate(locale, "ws.personal") });
}
