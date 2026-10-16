import { clearSessionCookie, destroySession } from "@/lib/auth";
import { crossSite, json } from "@/lib/http";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// POST /api/auth/logout — ends this device's session.
export async function POST(req: Request) {
  const rl = rateLimited(req, "auth-logout");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  destroySession(req.headers.get("cookie"));
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
}
