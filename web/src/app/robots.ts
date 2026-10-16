import type { MetadataRoute } from "next";
import { config } from "@/lib/config";
import { PRIVATE_PATHS } from "@/lib/notes/sitemap";

export const dynamic = "force-dynamic";

// /robots.txt: the public site and published pages are open (each published
// page still says noindex unless its author allowed indexing); the app, the
// API, forms and people's pages are not. Template previews (/templates/<id>)
// are public; the gallery itself (/templates, "$": that path only) is the
// app's and needs an account anyway. A test stand is never indexed.
const APP_PATHS = ["/templates$", "/projects", "/inbox", "/new", "/eco/", "/signin/", "/mail", "/calendar", "/cal/invite/", "/clip", "/clipper", "/scim/", "/offline", "/share-target", "/welcome"];

export default function robots(): MetadataRoute.Robots {
  if (config.isTestStand) return { rules: [{ userAgent: "*", disallow: "/" }] };
  // The sign-in page itself stays listed (the public site links to it); its sub-pages do not.
  const disallow = [...new Set([...PRIVATE_PATHS.filter((p) => p !== "/signin"), ...APP_PATHS])];
  return {
    rules: [{ userAgent: "*", allow: "/", disallow }],
    // No `host`: that line is a Yandex-only directive; Google and Bing ignore it.
    sitemap: `${config.appUrl}/sitemap.xml`,
  };
}
