import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { clipBudget, clipCaller } from "@/lib/clipper-auth";
import { config } from "@/lib/config";
import { fail, json } from "@/lib/http";
import { CLIP_LIMITS, saveClip, validClipRequest } from "@/lib/notes/clip";

export const dynamic = "force-dynamic";

// POST /api/notes/clip — saves a web page into Documents (lib/notes/clip.ts).
// The Web Clipper sends its token (Authorization: Bearer zvc_…); the web
// app's /clip page and the phone apps send the session cookie from our own
// origin. Body: { ws, target: {type: "private"} | {type: "page"|"database", id},
// mode: "article"|"bookmark"|"selection"|"text", url, title, html?, text?,
// excerpt?, cover?, siteName?, favicon?, images?: "link" } → { id, title, path, url }.

export async function POST(req: Request) {
  const rl = rateLimited(req, "notes-clip");
  if (rl) return rl;
  const who = clipCaller(req, true);
  if (who instanceof Response) return who;
  if (!who.user.consentOk) return fail(403, "consent required");
  const parsed = await readJsonCapped(req, CLIP_LIMITS.bodyBytes);
  if (!parsed.ok) return fail(parsed.status, parsed.status === 413 ? "too large" : "bad request");
  const clip = validClipRequest(parsed.value);
  if (!clip) return fail(400, "bad request");
  if (!clipBudget(who.user.id)) return json({ error: "Too many requests. Please try again later." }, 429, { "retry-after": "600" });
  try {
    const r = await saveClip(clip, { id: who.user.id, name: who.user.name });
    if (!r.ok) return fail(r.status, r.error);
    return json({ id: r.id, title: r.title, path: r.path, url: `${config.appUrl.replace(/\/$/, "")}${r.path}` });
  } catch {
    return fail(503, "unavailable");
  }
}
