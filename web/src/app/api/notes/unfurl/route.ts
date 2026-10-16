import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/rate-limit";
import { decodeEntities, readHtml } from "@/lib/web-read";
import { currentUser } from "@/lib/http";

export const dynamic = "force-dynamic";

// GET /api/notes/unfurl?url=… → { title, description, image, icon, url }
// Web bookmark previews in Documents (Open Graph / Twitter tags, <title>, favicon).
// Signed-in people only: the server fetches the page (through the SSRF guard
// of lib/web-read.ts), so it must not become an open proxy.

function meta(html: string, names: string[]): string {
  for (const name of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, "i");
    const tag = re.exec(html)?.[0];
    const content = tag ? /content=["']([^"']*)["']/i.exec(tag)?.[1] : undefined;
    if (content) return decodeEntities(content).trim();
  }
  return "";
}

function abs(href: string, base: string): string {
  try {
    const u = new URL(href, base);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : "";
  } catch {
    return "";
  }
}

export async function GET(req: Request) {
  const rl = rateLimited(req, "notes-unfurl");
  if (rl) return rl;
  if (!currentUser(req)) return NextResponse.json({ error: "sign in required" }, { status: 401 });
  const raw = new URL(req.url).searchParams.get("url") ?? "";
  if (!/^https?:\/\//i.test(raw) || raw.length > 2000) return NextResponse.json({ error: "bad url" }, { status: 400 });
  const page = await readHtml(raw, { signal: req.signal });
  if (!page) return NextResponse.json({ url: raw, title: "", description: "", image: "", icon: "" }, { headers: { "cache-control": "public, max-age=3600" } });
  const html = page.html;
  const title = meta(html, ["og:title", "twitter:title"]) || decodeEntities(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? "").trim();
  const description = meta(html, ["og:description", "twitter:description", "description"]);
  const image = abs(meta(html, ["og:image", "og:image:url", "twitter:image"]), page.url);
  const iconHref = /<link[^>]+rel=["'](?:shortcut )?icon["'][^>]*>/i.exec(html)?.[0];
  const icon = abs((iconHref && /href=["']([^"']+)["']/i.exec(iconHref)?.[1]) || "/favicon.ico", page.url);
  return NextResponse.json(
    { url: page.url, title: title.slice(0, 300), description: description.slice(0, 500), image: image.slice(0, 1000), icon: icon.slice(0, 1000) },
    { headers: { "cache-control": "private, max-age=86400" } }
  );
}
