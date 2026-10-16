import { crossSite, currentUser, fail, json } from "@/lib/http";
import { docsPresence } from "@/lib/notes/access";
import { favoritesOf, setFavorite } from "@/lib/notes/favorites";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";

export const dynamic = "force-dynamic";

// The signed-in person's favorites in a workspace (Notion's are personal).
// GET  ?ws=<id>                 → { ids }   (any member)
// POST ?ws=<id> { id, on }      → { ok }

export async function GET(req: Request) {
  const rl = rateLimited(req, "notes-sync");
  if (rl) return rl;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws");
  // Members and guests alike star the pages they see.
  const presence = docsPresence(me.user.id, ws);
  if (!presence) return fail(403, "forbidden");
  return json({ ids: favoritesOf(ws as string, me.user.id, presence.role === "owner") });
}

export async function POST(req: Request) {
  const rl = rateLimited(req, "notes-sync");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws");
  if (!docsPresence(me.user.id, ws)) return fail(403, "forbidden");
  const parsed = await readJsonCapped(req, 2_000);
  const body = parsed.ok ? (parsed.value as { id?: unknown; on?: unknown }) : {};
  if (typeof body.id !== "string" || typeof body.on !== "boolean") return fail(400, "bad request");
  return setFavorite(ws as string, me.user.id, body.id, body.on) ? json({ ok: true }) : fail(400, "limit");
}
