import { readCookie } from "@/lib/auth";
import { config } from "@/lib/config";
import { samlBounce, ssoFinish } from "@/lib/enterprise/sso-http";
import { finishSaml, SSO_COOKIE } from "@/lib/enterprise/sso";
import { crossSite } from "@/lib/http";
import { rateLimited } from "@/lib/rate-limit";
import { readFormCapped } from "@/lib/safe-json";
import { signInError } from "@/lib/signin";

export const dynamic = "force-dynamic";

// POST /api/sso/saml/<workspace>/acs — the Assertion Consumer Service: the
// identity provider's browser POST (SAMLResponse, RelayState). The first,
// cross-site POST carries no cookie of ours, so it is bounced back to this
// URL from our own origin (?b=1); only that same-origin POST is processed.
export async function POST(req: Request, { params }: { params: Promise<{ ws: string }> }) {
  const rl = rateLimited(req, "auth-callback");
  if (rl) return rl;
  const { ws } = await params;
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(ws)) return signInError("sso-failed", "/home");
  const form = await readFormCapped(req, 1_300_000);
  const samlResponse = form?.get("SAMLResponse");
  const relay = form?.get("RelayState");
  if (typeof samlResponse !== "string" || samlResponse.length > 1_200_000) return signInError("sso-failed", "/home");
  const relayState = typeof relay === "string" && relay.length <= 100 ? relay : null;
  const bounced = new URL(req.url).searchParams.get("b") === "1";
  const bind = readCookie(req, SSO_COOKIE);
  if (!bounced) {
    return samlBounce(`${config.appUrl}/api/sso/saml/${encodeURIComponent(ws)}/acs?b=1`, { SAMLResponse: samlResponse, ...(relayState ? { RelayState: relayState } : {}) }, req.headers.get("x-nonce"));
  }
  // The bounce came from our own page: anything else is a forged cross-site post.
  const bad = crossSite(req);
  if (bad) return bad;
  return ssoFinish(req, await finishSaml(ws, samlResponse, relayState, bind));
}
