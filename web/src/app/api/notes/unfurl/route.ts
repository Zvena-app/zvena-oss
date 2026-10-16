import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/rate-limit";
import { readHtml } from "@/lib/web-read";
import { cachedPreview, parsePreview } from "@/lib/notes/unfurl";
import { currentUser } from "@/lib/http";

export const dynamic = "force-dynamic";

// GET /api/notes/unfurl?url=… → { title, description, image, icon, url }
// Web bookmark previews in Documents (Open Graph / Twitter tags, <title>, favicon).
// Signed-in people only: the server fetches the page (through the SSRF guard
// of lib/web-read.ts), so it must not become an open proxy. The page is
// parsed by lib/notes/unfurl.ts (head only, linear time) and cached per URL.

export async function GET(req: Request) {
  const rl = rateLimited(req, "notes-unfurl");
  if (rl) return rl;
  if (!currentUser(req)) return NextResponse.json({ error: "sign in required" }, { status: 401 });
  const raw = new URL(req.url).searchParams.get("url") ?? "";
  if (!/^https?:\/\//i.test(raw) || raw.length > 2000) return NextResponse.json({ error: "bad url" }, { status: 400 });
  // Not tied to this request's signal: other requests may be waiting on the same fetch.
  const preview = await cachedPreview(raw, async () => {
    const page = await readHtml(raw);
    return page ? parsePreview(page.html, page.url) : null;
  });
  if (!preview) return NextResponse.json({ url: raw, title: "", description: "", image: "", icon: "" }, { headers: { "cache-control": "public, max-age=3600" } });
  return NextResponse.json(preview, { headers: { "cache-control": "private, max-age=86400" } });
}
