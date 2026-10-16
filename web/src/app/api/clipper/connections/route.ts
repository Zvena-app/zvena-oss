import { rateLimited } from "@/lib/rate-limit";
import { clipperConnections, revokeClipper } from "@/lib/clipper";
import { crossSite, currentUser, fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";

// GET    /api/clipper/connections       → { connections: [{ id, client, createdAt, lastUsedAt, expiresAt }] }
// DELETE /api/clipper/connections?id=…  → { ok }
// Settings → Connected apps: the person's Web Clippers (signed in, this site only).

export async function GET(req: Request) {
  const rl = rateLimited(req, "clipper");
  if (rl) return rl;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  return json({ connections: clipperConnections(me.user.id) });
}

export async function DELETE(req: Request) {
  const rl = rateLimited(req, "clipper");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const id = new URL(req.url).searchParams.get("id") ?? "";
  return revokeClipper(me.user.id, id) ? json({ ok: true }) : fail(404, "not found");
}
