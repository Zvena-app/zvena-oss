// zvena Documents: Notion Sites — the settings of a published page (/n/<id>).
// They live on the owner's note (note.share, synced) and travel with each
// published copy (snapshot.options), where the server checks them again.

export interface SiteOptions {
  /** Visitors may not duplicate the page. */
  noDup?: boolean;
  /** Search engines may index it. */
  index?: boolean;
  /** Search and link-preview title / description (the page's own when absent). */
  seoTitle?: string;
  seoDescription?: string;
  /** Social preview image: a file uploaded to Documents (same origin). */
  image?: string;
  /** The link stops working at this time (ms). */
  expiresAt?: number;
  /** Show the page outline (headings) beside the page. */
  outline?: boolean;
  /** Hide the breadcrumbs above the page. */
  noCrumbs?: boolean;
  /** Always light or dark (absent: the visitor's own). */
  theme?: "light" | "dark";
}

export const SEO_TITLE_MAX = 120;
export const SEO_DESCRIPTION_MAX = 300;
/** An expiry at most this far ahead (Notion offers a date; ten years is "never" enough). */
const EXPIRY_MAX = 10 * 366 * 86_400_000;

/** Only images uploaded to Documents can be a social image (no third-party host sees the visitors). */
export const SITE_IMAGE_RE = /^\/api\/notes\/file\/[a-f0-9]{40}\.(png|jpg|gif|webp|avif)$/;

const text = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : undefined;
};

/** Site settings from untrusted JSON (a device's sync or a publish request). */
export function cleanSiteOptions(v: unknown, now = Date.now()): SiteOptions {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
  const r = v as Record<string, unknown>;
  const o: SiteOptions = {};
  if (r.noDup === true) o.noDup = true;
  if (r.index === true) o.index = true;
  const title = text(r.seoTitle, SEO_TITLE_MAX);
  if (title) o.seoTitle = title;
  const description = text(r.seoDescription, SEO_DESCRIPTION_MAX);
  if (description) o.seoDescription = description;
  if (typeof r.image === "string" && SITE_IMAGE_RE.test(r.image)) o.image = r.image;
  // A past date is kept: it is how a link expires.
  if (typeof r.expiresAt === "number" && Number.isFinite(r.expiresAt) && r.expiresAt > 0 && r.expiresAt <= now + EXPIRY_MAX) o.expiresAt = Math.round(r.expiresAt);
  if (r.outline === true) o.outline = true;
  if (r.noCrumbs === true) o.noCrumbs = true;
  if (r.theme === "light" || r.theme === "dark") o.theme = r.theme;
  return o;
}

export function siteExpired(o: Pick<SiteOptions, "expiresAt"> | undefined, now = Date.now()): boolean {
  return typeof o?.expiresAt === "number" && o.expiresAt <= now;
}
