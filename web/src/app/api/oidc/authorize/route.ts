import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { currentUser } from "@/lib/http";
import { isLocale } from "@/i18n/locales";
import { UI_LANG_COOKIE } from "@/lib/i18n";
import { findClient, issueCode } from "@/lib/oidc";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// OIDC authorization endpoint (code flow). Signed in: straight back to Design
// with a one-time code. Not signed in: zvena's sign-in page, which comes back
// here (the request rides in `next`).
export async function GET(req: Request) {
  const rl = rateLimited(req, "auth-start", 60);
  if (rl) return rl;
  const url = new URL(req.url);
  const p = url.searchParams;
  const client = findClient(p.get("client_id"));
  const redirectUri = p.get("redirect_uri") ?? "";
  // Never redirect to an unregistered URI: answer here instead.
  if (!client || !client.redirectUris.includes(redirectUri)) {
    return NextResponse.json({ error: "invalid_request", error_description: "unknown client or redirect_uri" }, { status: 400 });
  }
  const back = new URL(redirectUri);
  const state = p.get("state");
  if (state) back.searchParams.set("state", state);
  if (p.get("response_type") !== "code") {
    back.searchParams.set("error", "unsupported_response_type");
    return NextResponse.redirect(back.toString(), 303);
  }
  const me = currentUser(req);
  if (!me) {
    const res = NextResponse.redirect(`${config.appUrl}/signin?next=${encodeURIComponent(`/api/oidc/authorize?${p.toString()}`)}`, 303);
    res.headers.set("cache-control", "no-store");
    return res;
  }
  if (!me.user.consentOk) {
    const res = NextResponse.redirect(`${config.appUrl}/consent?next=${encodeURIComponent(`/api/oidc/authorize?${p.toString()}`)}`, 303);
    res.headers.set("cache-control", "no-store");
    return res;
  }
  // The language the person chose in zvena (only an explicit choice: Design keeps its own default otherwise).
  const lang = new RegExp(`(?:^|;\\s*)${UI_LANG_COOKIE}=([a-z]{2})(?:;|$)`).exec(req.headers.get("cookie") ?? "")?.[1];
  back.searchParams.set("code", issueCode(me.user.id, client, redirectUri, p.get("nonce"), isLocale(lang) ? lang : null));
  const res = NextResponse.redirect(back.toString(), 303);
  res.headers.set("cache-control", "no-store");
  return res;
}
