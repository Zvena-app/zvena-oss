// Header and footer of the public pages of a zvena instance (help, legal,
// status and source pages, the sign-in screens). The website is in English;
// `locale` stays in the signature for the pages that pass it.

import Link from "next/link";
import { BrandMarkIcon, BrandWordmark } from "@/components/brand/BrandLogo";
import { config } from "@/lib/config";
import type { Locale } from "@/lib/i18n";
import { Email } from "./Email";
import { SiteMobileMenu, SiteNav, type SiteMenu } from "./SiteNav";

const MENU: SiteMenu[] = [
  {
    label: "Resources",
    items: [
      { href: "/help", title: "Help center", note: "Guides and answers" },
      { href: "/developers", title: "Docs API", note: "Build integrations and webhooks" },
      { href: "/status", title: "Status", note: "Is everything running?" },
      { href: "/source", title: "Source code", note: "The source of this instance" },
    ],
  },
];

export function PublicHeader({ signedIn }: { locale?: Locale; signedIn: boolean }) {
  return (
    <header className="zs-header">
      <div className="zs-header-in">
        <Link href="/" aria-label="zvena — home" className="zs-header-logo">
          <BrandWordmark className="zs-logo-long" />
          <BrandMarkIcon className="zs-logo-short" />
        </Link>
        <SiteNav menu={MENU} />
        <div className="zs-header-end">
          {signedIn ? (
            <Link className="zv-btn zv-btn-primary" href="/home">
              Open zvena
            </Link>
          ) : (
            <>
              <Link className="zs-login" href="/signin">
                Sign in
              </Link>
              <Link className="zv-btn zs-secondary" href="/docs">
                Try Docs
              </Link>
              <Link className="zv-btn zv-btn-primary" href="/signin">
                <span className="zs-long">Get started for free</span>
                <span className="zs-short">Get started</span>
              </Link>
            </>
          )}
          <SiteMobileMenu menu={MENU} signedIn={signedIn} />
        </div>
      </div>
    </header>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- pages still pass `locale`
export function PublicFooter(_props: { locale?: Locale }) {
  const company = config.company;
  return (
    <footer className="zs-footer">
      <div className="zs-footer-in">
        <div className="zs-footer-brand">
          <Link href="/" aria-label="zvena — home" className="zs-footer-logo">
            <BrandWordmark />
          </Link>
          <p>A workspace for design, docs, projects, calendar and mail.</p>
        </div>
        <nav className="zs-footer-col" aria-label="Resources">
          <h2>Resources</h2>
          <Link href="/help">Help center</Link>
          <Link href="/developers">Docs API</Link>
          <Link href="/status">Status</Link>
          <Link href="/source">Source code</Link>
          <a href="https://github.com/Zvena-app/zvena-oss">GitHub</a>
          <Link href="/report">Report abuse</Link>
        </nav>
        <nav className="zs-footer-col" aria-label="About">
          <h2>About</h2>
          <Email address={company.email} label="Contact" />
          <Link href="/legal/privacy">Privacy</Link>
          <Link href="/legal/terms">Terms</Link>
          <Link href="/legal/cookies">Cookies</Link>
        </nav>
      </div>
      <div className="zs-footer-bottom">
        <span>© {new Date().getUTCFullYear()} zvena</span>
        <span>English</span>
      </div>
    </footer>
  );
}
