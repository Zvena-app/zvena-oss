import { readCookie, signInWith } from "@/lib/auth";
import { config } from "@/lib/config";
import { clearNonceCookie, ONETAP_NONCE_COOKIE, verifyOneTap } from "@/lib/google";
import { crossSite, guestId } from "@/lib/http";
import { parseAcceptLanguage, resolveLocale, translate, UI_LANG_COOKIE } from "@/lib/i18n";
import { safeNext } from "@/lib/oauth";
import { rateLimited } from "@/lib/rate-limit";
import { finishSignIn, signInError } from "@/lib/signin";

export const dynamic = "force-dynamic";

// POST /api/auth/google/onetap (form: credential, next) — Google One Tap's ID
// token, submitted by components/zvena/GoogleOneTap.tsx. The page that shows
// One Tap also shows "By continuing, you agree to the Terms…".
export async function POST(req: Request) {
  const rl = rateLimited(req, "auth-onetap");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const form = await req.formData().catch(() => null);
  const next = safeNext(String(form?.get("next") ?? "/home"));
  if (!config.google.enabled) return signInError("provider", next);
  const profile = await verifyOneTap(String(form?.get("credential") ?? ""), readCookie(req, ONETAP_NONCE_COOKIE));
  if (!profile) {
    const res = signInError("failed", next);
    res.headers.append("set-cookie", clearNonceCookie());
    return res;
  }
  const result = signInWith(profile, config.consentVersion);
  if (!result.ok) return signInError(result.error, next);
  const locale = resolveLocale(readCookie(req, UI_LANG_COOKIE), parseAcceptLanguage(req.headers.get("accept-language")));
  const res = finishSignIn(result.user, { next, guest: guestId(req), isNew: result.isNew, personalName: translate(locale, "ws.personal") });
  res.headers.append("set-cookie", clearNonceCookie());
  return res;
}
