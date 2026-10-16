import type { MetadataRoute } from "next";
import { config } from "@/lib/config";
import { indexedNoteShares } from "@/lib/notes/server-store";

export const dynamic = "force-dynamic";

// /sitemap.xml: the public pages of the instance (keep in step with PublicChrome's
// links) and the Documents pages published with "Search engine indexing" on.
const PAGES: [string, number, MetadataRoute.Sitemap[number]["changeFrequency"]][] = [
  ["/help", 0.6, "monthly"],
  ["/developers", 0.5, "monthly"],
  ["/legal/privacy", 0.3, "yearly"],
  ["/legal/terms", 0.3, "yearly"],
  ["/legal/cookies", 0.2, "yearly"],
  ["/source", 0.2, "monthly"],
  ["/status", 0.2, "daily"],
];

/** When the public pages last changed; move it with each website release. */
const SITE_UPDATED = "2026-10-15";

export default function sitemap(): MetadataRoute.Sitemap {
  if (config.isTestStand) return [];
  // lastmod: the legal texts carry their own date; the rest moves with SITE_UPDATED.
  const site: MetadataRoute.Sitemap = PAGES.map(([path, priority, changeFrequency]) => ({
    url: `${config.appUrl}${path}`,
    lastModified: new Date(`${path.startsWith("/legal/") ? config.legalUpdated : SITE_UPDATED}T00:00:00Z`),
    changeFrequency,
    priority,
  }));
  const published: MetadataRoute.Sitemap = indexedNoteShares(50_000).map((s) => ({ url: `${config.appUrl}/n/${s.id}`, lastModified: new Date(s.updatedAt), changeFrequency: "weekly", priority: 0.5 }));
  return [...site, ...published];
}
