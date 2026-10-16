import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { crossSite, currentUser, fail, json } from "@/lib/http";
import { pressButton } from "@/lib/notes/automations-server";
import { readableFor } from "@/lib/notes/server-store";
import { NOTE_ID_RE } from "@/lib/notes/types";
import "@/lib/notes/reactions";
import { atLeast, docsPresence, pageLevel } from "@/lib/notes/access";

export const dynamic = "force-dynamic";

// A click on a Button property of a database row (Notion's button property).
// POST ?ws=<id> { dbId, rowId, propId } → { saved: notes }   (editors)
// The server runs the button's actions (edit properties, add pages, notify,
// webhook) as the person who clicked; steps that open something or ask for a
// confirmation run in their browser.

export async function POST(req: Request) {
  const rl = rateLimited(req, "notes-button");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws");
  if (!docsPresence(me.user.id, ws)) return fail(403, "forbidden");
  const parsed = await readJsonCapped(req, 2_000);
  if (!parsed.ok) return fail(parsed.status, "bad request");
  const { dbId, rowId, propId } = (parsed.value ?? {}) as Record<string, unknown>;
  if (typeof dbId !== "string" || !NOTE_ID_RE.test(dbId) || typeof rowId !== "string" || !NOTE_ID_RE.test(rowId) || typeof propId !== "string" || !/^[\w-]{1,40}$/.test(propId)) return fail(400, "bad request");
  // A button edits its row: edit access to that row is needed (a share counts).
  if (!atLeast(pageLevel(me.user.id, ws, rowId), "edit")) return fail(403, "forbidden");
  try {
    const res = pressButton(ws as string, dbId, rowId, propId, { id: me.user.id });
    // What it wrote, as the clicker may read it (hidden columns stay hidden).
    return res.ok ? json({ saved: res.saved.filter((n) => pageLevel(me.user.id, ws, n.id) !== null).map((n) => readableFor(ws as string, me.user.id, n)) }) : fail(res.status, res.error);
  } catch {
    return fail(503, "unavailable");
  }
}
