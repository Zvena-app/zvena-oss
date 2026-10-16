import { rateLimited } from "@/lib/rate-limit";
import { readCookie } from "@/lib/auth";
import { clipCaller } from "@/lib/clipper-auth";
import { json } from "@/lib/http";
import { guestSpacesOf } from "@/lib/notes/access";
import { WS_COOKIE } from "@/lib/session";
import { workspacesOf } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

// GET /api/clipper/me → { user: { id, name }, workspaces: [{ id, name, personal, role }], lastWs }
// The workspaces a clip can go to; guests' too (they may clip under a page
// shared with them for editing). Clients show their own word for the
// personal workspace (`personal: true`).

export async function GET(req: Request) {
  const rl = rateLimited(req, "clipper");
  if (rl) return rl;
  const who = clipCaller(req, false);
  if (who instanceof Response) return who;
  const user = who.user;
  const own = workspacesOf(user.id).map((w) => ({ id: w.id, name: w.name, personal: w.personal, role: w.role }));
  const guest = guestSpacesOf(user.id).map((g) => ({ id: g.id, name: g.name, personal: false, role: "guest" as const }));
  const all = [...own, ...guest];
  const last = who.via === "session" ? readCookie(req, WS_COOKIE) : null;
  const lastWs = all.some((w) => w.id === last) ? last : (own.find((w) => w.personal)?.id ?? all[0]?.id ?? null);
  return json({ user: { id: user.id, name: user.name }, workspaces: all, lastWs });
}
