import { NextResponse } from "next/server";
import { authStatus } from "@/lib/auth";
import { config } from "@/lib/config";
import { createEmailSignIn, normalizeEmail, sendSignInLetter } from "@/lib/email-signin";
import { ssoStartForEmail } from "@/lib/enterprise/gate";
import { crossSite, guestId } from "@/lib/http";
import { safeNext } from "@/lib/safe-next";
import { rateLimited } from "@/lib/rate-limit";
import { readFormCapped } from "@/lib/safe-json";
import { signInError } from "@/lib/signin";

export const dynamic = "force-dynamic";

// POST /api/auth/email/start (form: email, next) → a letter with a one-time
// link and code, then the "check your inbox" page. The answer is the same
// whether or not the address has an account.
export async function POST(req: Request) {
  const rl = rateLimited(req, "auth-email");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const form = await readFormCapped(req);
  const next = safeNext(String(form?.get("next") ?? "/home"));
  // An address whose workspace enforces SSO goes to its identity provider, not to its inbox.
  const sso = ssoStartForEmail(normalizeEmail(form?.get("email")), next);
  if (sso) return NextResponse.redirect(new URL(sso, config.appUrl), 303);
  if (!authStatus().email) return signInError("provider", next);
  const r = createEmailSignIn(form?.get("email"), { next, guest: guestId(req) });
  if (!r.ok) return signInError(r.error === "invalid" ? "email-invalid" : "email-too-many", next);
  const sent = await sendSignInLetter(r.email, r.token, r.code);
  if (!sent) return signInError("email-failed", next);
  const res = NextResponse.redirect(new URL(`/signin/check-email?r=${encodeURIComponent(r.ref)}`, config.appUrl), 303);
  res.headers.set("cache-control", "no-store");
  return res;
}
