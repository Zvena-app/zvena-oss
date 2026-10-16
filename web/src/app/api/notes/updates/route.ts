import { currentUser, fail, json } from "@/lib/http";
import { eventsOf, listVersions, namesOf } from "@/lib/notes/versions";
import { NOTE_ID_RE } from "@/lib/notes/types";
import { rateLimited } from "@/lib/rate-limit";
import { docsPresence, pageLevel } from "@/lib/notes/access";

export const dynamic = "force-dynamic";

// A page's Updates (Notion's): edit sessions and moves / trash / restores, newest first.
// GET ?ws=&id= → { versions, events, names }   (members; the page's comments come from the page itself)
export async function GET(req: Request) {
  const rl = rateLimited(req, "notes-history", 120);
  if (rl) return rl;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const url = new URL(req.url);
  const ws = url.searchParams.get("ws");
  if (!docsPresence(me.user.id, ws)) return fail(403, "forbidden");
  const id = url.searchParams.get("id") ?? "";
  if (!NOTE_ID_RE.test(id)) return fail(400, "bad request");
  if (!pageLevel(me.user.id, ws, id)) return fail(404, "not found");
  try {
    const versions = listVersions(ws as string, id, 200);
    const events = eventsOf(ws as string, id, 200);
    return json({ versions, events, names: namesOf([...versions.flatMap((x) => [x.by, x.acceptedBy ?? null]), ...events.map((e) => e.by)]) });
  } catch {
    return fail(503, "unavailable");
  }
}
