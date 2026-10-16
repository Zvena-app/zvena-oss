import { crossSite, currentUser, fail, json } from "@/lib/http";
import { docsPresence, pageLevel } from "@/lib/notes/access";
import { follows, setFollow } from "@/lib/notes/follows";
import { NOTE_ID_RE } from "@/lib/notes/types";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";

export const dynamic = "force-dynamic";

// Following a page (Notion's "Follow"): its edits and comments come to the Inbox.
// GET  ?ws=&id=          → { following }
// POST ?ws=&id= { on }   → { following }    (whoever may read the page)

function target(req: Request): { userId: string; ws: string; id: string } | Response {
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const url = new URL(req.url);
  const ws = url.searchParams.get("ws");
  if (!docsPresence(me.user.id, ws)) return fail(403, "forbidden");
  const id = url.searchParams.get("id") ?? "";
  if (!NOTE_ID_RE.test(id)) return fail(400, "bad request");
  if (!pageLevel(me.user.id, ws, id)) return fail(404, "not found");
  return { userId: me.user.id, ws: ws as string, id };
}

export async function GET(req: Request) {
  const rl = rateLimited(req, "notes-sync");
  if (rl) return rl;
  const t = target(req);
  if (t instanceof Response) return t;
  return json({ following: follows(t.ws, t.id, t.userId) });
}

export async function POST(req: Request) {
  const rl = rateLimited(req, "notes-sync");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const t = target(req);
  if (t instanceof Response) return t;
  const parsed = await readJsonCapped(req, 1_000);
  const on = parsed.ok ? (parsed.value as { on?: unknown } | null)?.on : undefined;
  if (typeof on !== "boolean") return fail(400, "bad request");
  return json({ following: setFollow(t.ws, t.id, t.userId, on) });
}
