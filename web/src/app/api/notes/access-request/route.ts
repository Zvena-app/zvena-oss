import { crossSite, currentUser, fail, json } from "@/lib/http";
import { requestAccess } from "@/lib/notes/access-requests";
import { NOTE_ID_RE } from "@/lib/notes/types";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// "Request access" to a page one cannot open (Notion).
// POST ?ws=&id= → { status: "requested" | "has" }   (any signed-in person; the page's full-access people hear of it)
// The answer is the same for a page that does not exist: links reveal nothing.

export async function POST(req: Request) {
  const rl = rateLimited(req, "notes-access-request", 10);
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "sign in required");
  const u = new URL(req.url);
  const ws = u.searchParams.get("ws") ?? "";
  const id = u.searchParams.get("id") ?? "";
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(ws) || !NOTE_ID_RE.test(id)) return fail(400, "bad request");
  try {
    return json({ status: requestAccess(ws, id, me.user.id) });
  } catch {
    return fail(503, "unavailable");
  }
}
