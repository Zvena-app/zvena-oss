import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { access, crossSite, currentUser, fail, json } from "@/lib/http";
import { automationRuns, setWorkspaceTz, workspaceTz } from "@/lib/notes/automations-server";
import { NOTE_ID_RE } from "@/lib/notes/types";
import { docsPresence, pageLevel } from "@/lib/notes/access";

export const dynamic = "force-dynamic";

// Database automations run on the server (src/lib/notes/automations-server.ts).
// GET   ?ws=<id>&db=<id> → { tz, runs: [{ automationId, at, runs, ok, error?, nextAt? }] }   (members)
// PATCH ?ws=<id> { tz }   → { tz }   the time zone scheduled automations keep time in (editors)

export async function GET(req: Request) {
  const rl = rateLimited(req, "notes-sync");
  if (rl) return rl;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const url = new URL(req.url);
  const ws = url.searchParams.get("ws");
  if (!docsPresence(me.user.id, ws)) return fail(403, "forbidden");
  const db = url.searchParams.get("db") ?? "";
  if (!NOTE_ID_RE.test(db)) return fail(400, "bad request");
  if (!pageLevel(me.user.id, ws, db)) return fail(404, "not found");
  try {
    return json({ tz: workspaceTz(ws as string), runs: automationRuns(ws as string, db) });
  } catch {
    return fail(503, "unavailable");
  }
}

export async function PATCH(req: Request) {
  const rl = rateLimited(req, "notes-share");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws");
  if (!access(me.user.id, ws, "edit")) return fail(403, "forbidden");
  const parsed = await readJsonCapped(req, 1_000);
  const tz = parsed.ok ? (parsed.value as { tz?: unknown } | null)?.tz : undefined;
  if (typeof tz !== "string" || !setWorkspaceTz(ws as string, tz)) return fail(400, "bad time zone");
  return json({ tz });
}
