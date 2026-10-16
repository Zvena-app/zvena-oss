import { config } from "@/lib/config";
import { SITE_HOST_HEADER } from "@/lib/enterprise/hosts";
import { shareForHost, siteOrigin } from "@/lib/enterprise/site-domains";
import { readNoteShare } from "@/lib/notes/server-store";

export const dynamic = "force-dynamic";

// robots.txt of a site on its custom domain (the proxy rewrites
// /robots.txt there to here and names the host): open to search engines
// when the author turned indexing on, closed otherwise. A test stand is
// never indexed.
export async function GET(req: Request) {
  const host = req.headers.get(SITE_HOST_HEADER);
  const shareId = host ? shareForHost(host) : null;
  if (!host || !shareId) return new Response("not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  const index = !config.isTestStand && readNoteShare(shareId)?.snapshot.options?.index === true;
  const body = index ? `User-agent: *\nAllow: /\n\nSitemap: ${siteOrigin(host)}/sitemap.xml\n` : "User-agent: *\nDisallow: /\n";
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });
}
