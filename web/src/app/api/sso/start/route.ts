import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { normalizeEmail } from "@/lib/email-signin";
import { selfPostingForm } from "@/lib/enterprise/sso-http";
import { ssoOf, ssoWorkspaceForEmail, startSso } from "@/lib/enterprise/sso";
import { guestId } from "@/lib/http";
import { safeNext } from "@/lib/safe-next";
import { rateLimited } from "@/lib/rate-limit";
import { signInError } from "@/lib/signin";

export const dynamic = "force-dynamic";

// GET /api/sso/start?email=…&next=…  (or ?ws=<workspace>) → the workspace's
// identity provider. The address picks the workspace by its verified domain.
// The SSO button sits next to "By continuing, you agree to the Terms…", so
// the Terms version travels with the sign-in, as with the e-mail link.
export async function GET(req: Request) {
  const rl = rateLimited(req, "auth-start");
  if (rl) return rl;
  const url = new URL(req.url);
  const next = safeNext(url.searchParams.get("next"));
  const wsParam = url.searchParams.get("ws");
  const email = normalizeEmail(url.searchParams.get("email"));
  const ws = wsParam && /^[A-Za-z0-9_-]{8,40}$/.test(wsParam) && ssoOf(wsParam)?.enabled ? wsParam : ssoWorkspaceForEmail(email);
  if (!ws) return signInError(email ? "sso-unknown" : "sso-failed", next);
  try {
    const s = await startSso(ws, { next, guest: guestId(req), consent: config.consentVersion });
    const res = s.html ? selfPostingForm(s.html, req.headers.get("x-nonce")) : NextResponse.redirect(s.location as string, 303);
    res.headers.set("cache-control", "no-store");
    res.headers.append("set-cookie", s.cookie);
    return res;
  } catch {
    return signInError("sso-failed", next);
  }
}
