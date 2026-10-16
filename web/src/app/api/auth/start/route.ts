import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { guestId } from "@/lib/http";
import { isOAuthProvider, providerEnabled, safeNext, startOAuth } from "@/lib/oauth";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// GET /api/auth/start?provider=google|github&next=/docs → the provider's
// sign-in page. The buttons sit next to "By continuing, you agree to the
// Terms…", so the Terms version travels in the one-time state row.
export async function GET(req: Request) {
  const rl = rateLimited(req, "auth-start");
  if (rl) return rl;
  const url = new URL(req.url);
  const provider = url.searchParams.get("provider");
  const next = safeNext(url.searchParams.get("next"));
  if (!isOAuthProvider(provider) || !providerEnabled(provider)) {
    return NextResponse.redirect(new URL(`/signin?error=provider&next=${encodeURIComponent(next)}`, config.appUrl), 303);
  }
  const started = startOAuth(provider, { consent: config.consentVersion, next, guest: guestId(req) });
  const res = NextResponse.redirect(started.url, 303);
  res.headers.set("cache-control", "no-store");
  // Ties the callback to this browser (login CSRF).
  res.headers.append("set-cookie", started.cookie);
  return res;
}
