import { rateLimited } from "@/lib/rate-limit";
import { clipCaller } from "@/lib/clipper-auth";
import { fail, json } from "@/lib/http";
import { docsPresence } from "@/lib/notes/access";
import { clipDestinations } from "@/lib/notes/clip";

export const dynamic = "force-dynamic";

// GET /api/clipper/destinations?ws=<id>&q=<text> → { results: [{ id, kind, title, icon, path }] }
// Pages and databases the caller may add a clip to (titles only, never content).

export async function GET(req: Request) {
  const rl = rateLimited(req, "clipper");
  if (rl) return rl;
  const who = clipCaller(req, false);
  if (who instanceof Response) return who;
  const url = new URL(req.url);
  const ws = url.searchParams.get("ws");
  if (!docsPresence(who.user.id, ws)) return fail(403, "forbidden");
  const q = (url.searchParams.get("q") ?? "").slice(0, 100);
  return json({ results: clipDestinations(ws as string, who.user.id, q) });
}
