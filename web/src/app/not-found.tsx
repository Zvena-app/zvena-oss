import type { Metadata } from "next";
import Link from "next/link";
import { pageUser } from "@/lib/page";
import { PublicFooter, PublicHeader } from "@/components/zvena/PublicChrome";

// Any address zvena doesn't know, in the website's look (the wrapper carries
// the `zs` class: an unknown path isn't one lib/site.ts recognizes).

// No canonical or og:url: the layout's ones would name the missing address itself.
export const metadata: Metadata = {
  title: "Page not found",
  description: "This page doesn’t exist on zvena. It may have been moved, deleted or unpublished.",
  robots: { index: false, follow: true },
  alternates: { canonical: null },
  openGraph: { title: "Page not found · zvena", description: "This page doesn’t exist on zvena.", siteName: "zvena", type: "website" },
};

export default async function NotFound() {
  const { user } = await pageUser();
  return (
    <div className="zs zs-page">
      <PublicHeader signedIn={Boolean(user)} />
      <main className="zs-404">
        <p className="zs-404-code">404</p>
        <h1>This page doesn&rsquo;t exist</h1>
        <p>The link may be mistyped, or the page was moved or deleted. A shared page stops working when its owner unpublishes it.</p>
        <div className="zv-actions">
          <Link className="zv-btn zv-btn-primary zv-btn-lg" href={user ? "/home" : "/"}>
            {user ? "Open zvena" : "Go to the home page"}
          </Link>
          <Link className="zv-btn zv-btn-lg" href="/help">
            Help center
          </Link>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
