import { designContext, UUID_RE } from "@/lib/design-api";
import { fail } from "@/lib/http";
import { frameImage, framePreview } from "@/lib/penpot";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// GET /api/design/frame-image?ws=<id>&file=<uuid>&frame=<uuid>[&v=<revn>] — the
// frame's current thumbnail (Design renders it while the design is edited).
// Private: only members of the workspace; the browser may cache a version.
export async function GET(req: Request) {
  const rl = rateLimited(req, "design-preview");
  if (rl) return rl;
  const c = await designContext(req);
  if (c instanceof Response) return c;
  const u = new URL(req.url);
  const file = u.searchParams.get("file") ?? "";
  const frame = u.searchParams.get("frame") ?? "";
  if (!UUID_RE.test(file) || !UUID_RE.test(frame)) return fail(400, "bad ids");
  try {
    const meta = await framePreview(c.userId, file, frame);
    if (meta.teamId !== c.teamId) return fail(404, "not found");
    const img = await frameImage(c.userId, file, frame);
    if (!img) return fail(404, "no preview yet");
    const type = /^image\/(png|jpeg|webp)$/.test(img.type) ? img.type : "image/png";
    return new Response(img.bytes, {
      headers: {
        "content-type": type,
        "cache-control": u.searchParams.get("v") ? "private, max-age=86400" : "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  } catch {
    return fail(404, "not found");
  }
}
