import { NextResponse } from "next/server";
import { clientSecretOk, consumeCode, findClient, issueAccessToken } from "@/lib/oidc";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

function fail(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

// OIDC token endpoint: server-to-server from Design's backend.
export async function POST(req: Request) {
  const rl = rateLimited(req, "auth-callback", 600);
  if (rl) return rl;
  const raw = await req.text();
  if (raw.length > 8_000) return fail("invalid_request", 400);
  const form = new URLSearchParams(raw);
  let id = form.get("client_id") ?? "";
  let secret = form.get("client_secret") ?? "";
  const basic = (req.headers.get("authorization") ?? "").match(/^Basic\s+(.+)$/i);
  if (basic) {
    const [u, s] = Buffer.from(basic[1], "base64").toString("utf8").split(":");
    id = decodeURIComponent(u ?? "");
    secret = decodeURIComponent(s ?? "");
  }
  const client = findClient(id);
  if (!client || !clientSecretOk(client, secret)) return fail("invalid_client", 401);
  if (form.get("grant_type") !== "authorization_code") return fail("unsupported_grant_type", 400);
  const grant = consumeCode(form.get("code") ?? "", client, form.get("redirect_uri") ?? "");
  if (!grant) return fail("invalid_grant", 400);
  return NextResponse.json({ access_token: issueAccessToken(grant.userId, client, grant.locale), token_type: "Bearer", expires_in: 600, scope: "openid profile email" }, { headers: NO_STORE });
}
