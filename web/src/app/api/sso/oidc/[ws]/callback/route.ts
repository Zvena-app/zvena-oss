import { readCookie } from "@/lib/auth";
import { ssoFinish } from "@/lib/enterprise/sso-http";
import { finishOidc, SSO_COOKIE } from "@/lib/enterprise/sso";
import { rateLimited } from "@/lib/rate-limit";
import { signInError } from "@/lib/signin";

export const dynamic = "force-dynamic";

// GET /api/sso/oidc/<workspace>/callback?code=…&state=… — back from the
// workspace's OpenID Connect provider (the redirect URI registered there).
export async function GET(req: Request, { params }: { params: Promise<{ ws: string }> }) {
  const rl = rateLimited(req, "auth-callback");
  if (rl) return rl;
  const { ws } = await params;
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(ws)) return signInError("sso-failed", "/home");
  const url = new URL(req.url);
  return ssoFinish(req, await finishOidc(ws, url.searchParams, readCookie(req, SSO_COOKIE)));
}
