import { crossSite, currentUser, fail, json } from "@/lib/http";
import { analyticsOf, recordView } from "@/lib/notes/versions";
import { NOTE_ID_RE } from "@/lib/notes/types";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { docsPresence, pageLevel } from "@/lib/notes/access";

export const dynamic = "force-dynamic";

// Page analytics of Documents (Notion's "Analytics" in the page menu).
// POST ?ws= { noteId }    → { counted }   a member opened the page (one per person and page per 30 minutes)
// GET  ?ws=&id=&tz=<min>  → { views, viewers, days[28], recentViewers, editors }   (members only: names stay inside the workspace)
export async function POST(req: Request) {
  const rl = rateLimited(req, "notes-view", 120);
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws");
  if (!docsPresence(me.user.id, ws)) return fail(403, "forbidden");
  const p = await readJsonCapped(req, 1_000);
  const noteId = p.ok ? (p.value as { noteId?: unknown } | null)?.noteId : undefined;
  if (typeof noteId !== "string" || !NOTE_ID_RE.test(noteId)) return fail(400, "bad request");
  if (!pageLevel(me.user.id, ws, noteId)) return fail(404, "not found");
  try {
    return json({ counted: recordView(ws as string, noteId, me.user.id) });
  } catch {
    return fail(503, "unavailable");
  }
}

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
  const tz = Number(url.searchParams.get("tz") ?? "0");
  try {
    return json(analyticsOf(ws as string, id, Date.now(), Number.isFinite(tz) ? tz : 0));
  } catch {
    return fail(503, "unavailable");
  }
}
