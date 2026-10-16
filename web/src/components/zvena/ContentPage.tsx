// The frame of zvena's long-form public pages (About, comparisons, guides,
// help): public header and footer, a readable column, and a call to action
// at the end.

import Link from "next/link";
import type { ReactNode } from "react";
import { pageUser } from "@/lib/page";
import { PublicFooter, PublicHeader } from "./PublicChrome";

export async function ContentPage({ title, lead, children, cta, eyebrow }: { title: string; lead: string; children: ReactNode; cta?: { href: string; label: string } | false; eyebrow?: string }) {
  const { user, locale } = await pageUser();
  return (
    <>
      <PublicHeader locale={locale} signedIn={Boolean(user)} />
      <main className="zv-prose">
        {eyebrow && <p className="zv-eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        <p className="zv-prose-lead">{lead}</p>
        {children}
        {cta !== false && (
          <div className="zv-cta-box">
            <p>{user ? "Pick up where you left off." : "Free for everyone. No credit card, no trial, no ads."}</p>
            <div className="zv-actions">
              <Link className="zv-btn zv-btn-primary zv-btn-lg" href={user ? "/home" : cta?.href ?? "/signin"}>
                {user ? "Open zvena" : cta?.label ?? "Get started"}
              </Link>
              {!user && (
                <Link className="zv-btn zv-btn-lg" href="/docs">
                  Try Docs without an account
                </Link>
              )}
            </div>
          </div>
        )}
      </main>
      <PublicFooter locale={locale} />
    </>
  );
}

export function Yes({ children = "Yes" }: { children?: ReactNode }) {
  return <span className="zv-yes">✓ {children}</span>;
}
export function No({ children = "No" }: { children?: ReactNode }) {
  return <span className="zv-no">✗ {children}</span>;
}
export function Part({ children }: { children: ReactNode }) {
  return <span className="zv-part">≈ {children}</span>;
}
