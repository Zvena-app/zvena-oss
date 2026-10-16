import { clearSessionCookie, destroyAllSessions } from "@/lib/auth";
import { revokeAllClippers } from "@/lib/clipper";
import { crossSite, currentUser, fail, json } from "@/lib/http";
import { rateLimited } from "@/lib/rate-limit";
import { audit } from "@/lib/store";

export const dynamic = "force-dynamic";

// POST /api/auth/logout-all — ends the account's sessions on every device (and disconnects its Web Clippers).
export async function POST(req: Request) {
  const rl = rateLimited(req, "auth-logout");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const n = destroyAllSessions(me.user.id);
  // Connected Web Clippers are devices too.
  const clippers = revokeAllClippers(me.user.id);
  audit(me.user.id, "sessions.revoke", null, { n, clippers });
  return json({ ok: true, ended: n }, 200, { "set-cookie": clearSessionCookie() });
}
