import { NextResponse } from "next/server";
import { getUser, readAccessToken, userClaims } from "@/lib/oidc";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

async function handle(req: Request) {
  const rl = rateLimited(req, "auth-callback", 600);
  if (rl) return rl;
  const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(\S+)$/i);
  const at = m ? readAccessToken(m[1]) : null;
  const user = at ? getUser(at.userId) : null;
  if (!user) return NextResponse.json({ error: "invalid_token" }, { status: 401, headers: { "www-authenticate": 'Bearer error="invalid_token"', "cache-control": "no-store" } });
  return NextResponse.json(userClaims(user, at?.locale ?? null), { headers: { "cache-control": "no-store" } });
}

export const GET = handle;
export const POST = handle;
