import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { access, crossSite, currentUser, fail, json } from "@/lib/http";
import { addEmoji, emojiName, listEmoji, removeEmoji } from "@/lib/notes/custom-emoji";
import { docsPresence } from "@/lib/notes/access";

export const dynamic = "force-dynamic";

// A workspace's custom emoji (see src/lib/notes/custom-emoji.ts).
// GET    ?ws=                  → { emoji: [{ name, url, createdBy, createdAt }] }   (members)
// POST   ?ws= { name, url }    → { emoji }                                           (editors; url = an uploaded image)
// DELETE ?ws= { name }         → { ok }                                              (editors)

export async function GET(req: Request) {
  const rl = rateLimited(req, "notes-emoji", 120);
  if (rl) return rl;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws");
  // Guests read the workspace's emoji too: the pages shared with them use them.
  if (!docsPresence(me.user.id, ws)) return fail(403, "forbidden");
  return json({ emoji: listEmoji(ws as string) });
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const p = await readJsonCapped(req, 4_000);
  return p.ok && typeof p.value === "object" && p.value !== null ? (p.value as Record<string, unknown>) : {};
}

export async function POST(req: Request) {
  const rl = rateLimited(req, "notes-emoji", 60);
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws");
  if (!access(me.user.id, ws, "edit")) return fail(403, "forbidden");
  const { name, url } = await body(req);
  if (typeof name !== "string" || typeof url !== "string") return fail(400, "bad request");
  const res = addEmoji(ws as string, emojiName(name), url, me.user.id);
  if (!res.ok) return fail(res.error === "taken" ? 409 : res.error === "limit" ? 507 : 400, res.error);
  return json({ emoji: res.emoji });
}

export async function DELETE(req: Request) {
  const rl = rateLimited(req, "notes-emoji", 60);
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws");
  if (!access(me.user.id, ws, "edit")) return fail(403, "forbidden");
  const { name } = await body(req);
  if (typeof name !== "string") return fail(400, "bad request");
  return json({ ok: removeEmoji(ws as string, name) });
}
