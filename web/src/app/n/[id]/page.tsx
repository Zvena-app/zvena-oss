// The server-rendered page is styled before any script runs.
import "@blocknote/ariakit/style.css";
import { enRu } from "@/i18n/locales";
import "@/components/notes/notes.css";
import "@/components/notes/theme.css";

import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { config } from "@/lib/config";
import { SITE_HOST_HEADER, SITE_ROOT_ID } from "@/lib/enterprise/hosts";
import { customDomainOf, shareForHost, shareServable, siteOrigin } from "@/lib/enterprise/site-domains";
import { UI_LANG_COOKIE, parseAcceptLanguage, resolveLocale, type Locale } from "@/lib/i18n";
import { notesT } from "@/lib/notes/i18n";
import { noteShareExpired, readNoteShare } from "@/lib/notes/server-store";
import { blocksText, iconText } from "@/lib/notes/model";
import { firstImage } from "@/lib/notes/db";
import { SITE_IMAGE_RE } from "@/lib/notes/sites";
import { PublicStatic, SiteThemeScript } from "@/components/notes/PublicStatic";
import { PublicNoteRoot } from "./PublicNoteRoot";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/**
 * Which published page this request shows: /n/<id> on zvena, or the page a
 * custom domain serves (the proxy rewrote "/" there to /n/_site and named the
 * host). A page whose workspace turned publishing off is served nowhere.
 */
async function resolve(id: string): Promise<{ shareId: string; host: string | null } | null> {
  const host = (await headers()).get(SITE_HOST_HEADER);
  if (host) {
    const shareId = id === SITE_ROOT_ID ? shareForHost(host) : null;
    return shareId ? { shareId, host } : null;
  }
  if (id === SITE_ROOT_ID || !shareServable(id)) return null;
  return { shareId: id, host: null };
}

async function locale(): Promise<Locale> {
  const [h, c] = await Promise.all([headers(), cookies()]);
  return resolveLocale(c.get(UI_LANG_COOKIE)?.value, parseAcceptLanguage(h.get("accept-language")));
}

// Published zvena Documents pages (Notion Sites): reachable by anyone with the
// link; indexed only when the author turned "Search engine indexing" on. The
// page is server-rendered (search engines and link previews read it), then
// the interactive view takes over.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const at = await resolve(id);
  const share = at ? readNoteShare(at.shareId) : null;
  const lang = await locale();
  if (!share || !at) {
    const title = at && noteShareExpired(at.shareId) ? notesT(lang, "public.expired") : "zvena";
    return { title, robots: { index: false, follow: false } };
  }
  const o = share.snapshot.options ?? {};
  const root = share.snapshot.notes.find((n) => n.id === share.snapshot.rootId);
  const icon = iconText(root?.icon);
  const title = o.seoTitle || `${icon ? `${icon} ` : ""}${share.title || notesT(lang, "page.untitled")}`;
  const description = o.seoDescription || blocksText(root?.content ?? [], 0, 2000).replace(/\s+/g, " ").trim().slice(0, 160);
  // The social image: the one chosen, else the cover or the first image when it is an upload here.
  const candidates = [o.image, root?.cover?.kind === "image" ? root.cover.value : "", firstImage(root?.content ?? [])];
  const image = candidates.find((x): x is string => typeof x === "string" && SITE_IMAGE_RE.test(x));
  // A site with a custom domain lives there (its canonical address, on zvena too).
  const domain = at.host ?? customDomainOf(share.id);
  const url = domain ? `${siteOrigin(domain)}/` : `${config.appUrl}/n/${share.id}`;
  const index = o.index === true;
  return {
    title,
    description,
    alternates: { canonical: url },
    robots: { index, follow: index },
    openGraph: { title, description, siteName: "zvena", type: "article", url, ...(image ? { images: [{ url: `${config.appUrl}${image}` }] } : {}) },
    twitter: { card: image ? "summary_large_image" : "summary", title, description, ...(image ? { images: [`${config.appUrl}${image}`] } : {}) },
  };
}

function Expired({ lang, app }: { lang: "ru" | "en"; app: string }) {
  return (
    <div className="nt-pub nt-pub-gone" role="status" style={{ display: "grid", placeItems: "center", minHeight: "60vh", textAlign: "center", padding: 48 }}>
      <div>
        <h1 style={{ fontSize: 24, margin: "0 0 8px" }}>{notesT(lang, "public.expired")}</h1>
        <p style={{ color: "var(--nt-text-2, #787774)" }}>{notesT(lang, "public.expiredHint")}</p>
        <p>
          <Link href={`${app}/`}>{notesT(lang, "public.by")}</Link>
        </p>
      </div>
    </div>
  );
}

export default async function PublicNotePage({ params }: Props) {
  const { id } = await params;
  const lang = await locale();
  const at = await resolve(id);
  if (!at) notFound();
  const share = readNoteShare(at.shareId, true);
  if (!share) {
    if (noteShareExpired(at.shareId)) return <Expired lang={enRu(lang)} app={at.host ? config.appUrl : ""} />;
    notFound();
  }
  // On a custom domain, links to zvena itself (its home, Duplicate, Report) go to zvena.
  const app = at.host ? config.appUrl : "";
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const { snapshot } = share;
  return (
    <>
      <SiteThemeScript theme={snapshot.options?.theme} nonce={nonce} />
      <PublicNoteRoot snapshot={snapshot} updatedAt={share.updatedAt} shareId={share.id} app={app}>
        <PublicStatic notes={snapshot.notes} rootId={snapshot.rootId} options={snapshot.options} updatedAt={share.updatedAt} locale={lang} base={config.appUrl} shareId={share.id} app={app} />
      </PublicNoteRoot>
    </>
  );
}
