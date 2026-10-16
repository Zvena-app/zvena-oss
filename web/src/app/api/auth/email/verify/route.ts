import { NextResponse } from "next/server";
import { readCookie, signInWith } from "@/lib/auth";
import { config } from "@/lib/config";
import { consumeCode, consumeLink } from "@/lib/email-signin";
import { crossSite, guestId } from "@/lib/http";
import { parseAcceptLanguage, resolveLocale, translate, UI_LANG_COOKIE } from "@/lib/i18n";
import { rateLimited } from "@/lib/rate-limit";
import { finishSignIn, signInError } from "@/lib/signin";

export const dynamic = "force-dynamic";

// POST /api/auth/email/verify — form: token (the link's "Continue" button)
// or ref + code (typed on the "check your inbox" page).
export async function POST(req: Request) {
  const rl = rateLimited(req, "auth-email-verify");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const form = await req.formData().catch(() => null);
  const token = form?.get("token");
  const ref = String(form?.get("ref") ?? "");
  const r = typeof token === "string" && token ? consumeLink(token) : consumeCode(ref, form?.get("code"));
  if (!r.ok) {
    if (r.error === "wrong-code") {
      const res = NextResponse.redirect(new URL(`/signin/check-email?r=${encodeURIComponent(ref)}&error=wrong-code`, config.appUrl), 303);
      res.headers.set("cache-control", "no-store");
      return res;
    }
    return signInError("email-expired", "/home");
  }
  const result = signInWith({ provider: "email", subject: r.email, name: "", email: r.email, emailVerified: true }, config.consentVersion);
  if (!result.ok) return signInError(result.error, r.next);
  const locale = resolveLocale(readCookie(req, UI_LANG_COOKIE), parseAcceptLanguage(req.headers.get("accept-language")));
  // Guest files move into the account only in the browser that asked for the letter: a link
  // someone else requested must not carry their guest uploads into this account.
  const guest = r.guest && r.guest === guestId(req) ? r.guest : null;
  return finishSignIn(result.user, { next: r.next, guest, isNew: result.isNew, personalName: translate(locale, "ws.personal") });
}
