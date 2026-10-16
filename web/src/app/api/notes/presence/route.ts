import { config } from "@/lib/config";
import { crossSite, currentUser, fail, json } from "@/lib/http";
import { atLeast, docsPresence, levelOf } from "@/lib/notes/access";
import { NOTE_ID_RE } from "@/lib/notes/types";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { sql } from "@/lib/store";

export const dynamic = "force-dynamic";

// POST /api/notes/presence?ws=<id> { noteId, leave? } → { others: string[], full: boolean, limit }
// A heartbeat (every 30 s) of an editor with a document open: others see who
// else is editing, and over the configurable limit (ZVENA_MAX_EDITORS_PER_DOC,
// never under 3; 0 = no limit) a newcomer opens the document read-only.
const ACTIVE_MS = 75_000;

export async function POST(req: Request) {
  const rl = rateLimited(req, "notes-presence");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws");
  if (!docsPresence(me.user.id, ws)) return fail(403, "forbidden");
  const p = await readJsonCapped(req, 2_000);
  const body = p.ok ? (p.value as { noteId?: unknown; leave?: unknown }) : {};
  if (typeof body.noteId !== "string" || !NOTE_ID_RE.test(body.noteId)) return fail(400, "bad request");
  // Editing presence is for people who may edit this page.
  if (!atLeast(levelOf(ws as string, me.user.id, body.noteId), "edit")) return fail(403, "forbidden");
  const now = Date.now();
  if (body.leave === true) {
    sql("DELETE FROM presence WHERE ws = ? AND note_id = ? AND user_id = ?").run(ws, body.noteId, me.user.id);
    return json({ others: [], full: false, limit: config.maxEditorsPerDoc });
  }
  const others = sql(
    "SELECT u.name FROM presence p JOIN users u ON u.id = p.user_id WHERE p.ws = ? AND p.note_id = ? AND p.user_id != ? AND p.at > ? ORDER BY p.at"
  ).all(ws, body.noteId, me.user.id, now - ACTIVE_MS) as { name: string }[];
  const wasIn = Boolean(sql("SELECT 1 FROM presence WHERE ws = ? AND note_id = ? AND user_id = ? AND at > ?").get(ws, body.noteId, me.user.id, now - ACTIVE_MS));
  const limit = config.maxEditorsPerDoc;
  // Someone already editing keeps their place; a newcomer waits while the document is full.
  const full = limit > 0 && !wasIn && others.length >= limit;
  if (!full) {
    sql("INSERT INTO presence (ws, note_id, user_id, at) VALUES (?, ?, ?, ?) ON CONFLICT(ws, note_id, user_id) DO UPDATE SET at = excluded.at").run(ws, body.noteId, me.user.id, now);
  }
  return json({ others: others.map((o) => o.name), full, limit });
}
