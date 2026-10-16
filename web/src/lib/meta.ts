import type { Metadata } from "next";

// Metadata for a public page: title, description, canonical address, and the
// link preview (Open Graph and X/Twitter) with zvena's picture. A page that
// sets `openGraph` itself replaces the layout's whole preview — the picture
// included — so every public page goes through here.

const IMAGE = { url: "/brand/icon-512.png", width: 512, height: 512, alt: "zvena" };

export function pageMetadata({ title, description, path, previewTitle, robots }: { title: string; description: string; path: string; previewTitle?: string; robots?: Metadata["robots"] }): Metadata {
  const preview = previewTitle ?? `${title} · zvena`;
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { title: preview, description, url: path, siteName: "zvena", type: "website", locale: "en_US", images: [IMAGE] },
    twitter: { card: "summary", title: preview, description, images: [IMAGE.url] },
    ...(robots ? { robots } : {}),
  };
}
