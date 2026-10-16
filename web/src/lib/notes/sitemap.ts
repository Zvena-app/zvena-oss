// Server-only: what search engines may list — the public pages of the site
// and the Documents pages published with "Search engine indexing" on.

import { indexedNoteShares } from "./server-store";

/** Public pages of the instance itself (help, legal). */
export const PUBLIC_PATHS = ["/help", "/source", "/legal/privacy", "/legal/terms", "/legal/cookies"] as const;

/** Paths search engines are asked to skip: the app itself, its APIs, forms and sign-in. */
export const PRIVATE_PATHS = ["/docs", "/api/", "/admin", "/settings", "/team", "/home", "/design", "/design-links", "/signin", "/signout", "/consent", "/join/", "/f/", "/report"] as const;

export interface SitemapEntry {
  url: string;
  lastModified?: Date;
  changeFrequency?: "daily" | "weekly" | "monthly";
  priority?: number;
}

export function sitemapEntries(base: string, now = Date.now()): SitemapEntry[] {
  const site: SitemapEntry[] = PUBLIC_PATHS.map((p) => ({ url: `${base}${p}`, changeFrequency: "monthly", priority: 0.6 }));
  const pages: SitemapEntry[] = indexedNoteShares(50_000, now).map((s) => ({ url: `${base}/n/${s.id}`, lastModified: new Date(s.updatedAt), changeFrequency: "weekly", priority: 0.5 }));
  return [...site, ...pages];
}
