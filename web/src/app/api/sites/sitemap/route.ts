import { config } from "@/lib/config";
import { SITE_HOST_HEADER } from "@/lib/enterprise/hosts";
import { shareForHost, siteOrigin } from "@/lib/enterprise/site-domains";
import { readNoteShare } from "@/lib/notes/server-store";

export const dynamic = "force-dynamic";

// sitemap.xml of a site on its custom domain (rewritten here by the proxy):
// the site's address, when the author allowed search engines.
export async function GET(req: Request) {
  const host = req.headers.get(SITE_HOST_HEADER);
  const shareId = host ? shareForHost(host) : null;
  const share = shareId ? readNoteShare(shareId) : null;
  if (!host || !share) return new Response("not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  const urls = !config.isTestStand && share.snapshot.options?.index === true ? [`  <url><loc>${siteOrigin(host)}/</loc><lastmod>${new Date(share.updatedAt).toISOString()}</lastmod></url>`] : [];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}${urls.length ? "\n" : ""}</urlset>\n`;
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=300" } });
}
