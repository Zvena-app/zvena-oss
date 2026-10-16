import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import { I18nProvider } from "@/lib/i18n-provider";
import { UI_LANG_COOKIE, parseAcceptLanguage, resolveLocale, translate } from "@/lib/i18n";
import { dirOf } from "@/i18n/locales";
import { messagesOf } from "@/i18n/runtime";
// Every language's catalogs, on the server only (registered on import).
import "@/i18n/server-catalogs";
import { config } from "@/lib/config";
import { SITE_HOST_HEADER } from "@/lib/enterprise/hosts";
import { isEnglishOnlyPath, isSitePath } from "@/lib/site";
import { SHELL_RESTORE } from "@/components/notes/NotesShell";
import { CookieNotice } from "@/components/zvena/CookieNotice";
import { ServiceWorker } from "@/components/zvena/ServiceWorker";
import { swScope } from "@/lib/sw-scope";
import "katex/dist/katex.min.css";
import "./zvena.css";
import "./site.css";
// One look for every product (Figma-style tokens over each product's own variables).
import "./ui-theme.css";
// Phones and tablets: one layer over every section (app/responsive/shell.css explains it).
import "./responsive/shell.css";
import "./responsive/workspace.css";
import "./responsive/docs.css";
import "./responsive/projects.css";
import "./responsive/calendar.css";
import "./responsive/mail.css";
import "./responsive/site.css";

async function requestLocale() {
  const [c, h] = await Promise.all([cookies(), headers()]);
  return {
    // English-only pages stay English (and left to right) whatever language the app is in.
    locale: isEnglishOnlyPath(h.get("x-zv-path")) ? ("en" as const) : resolveLocale(c.get(UI_LANG_COOKIE)?.value, parseAcceptLanguage(h.get("accept-language"))),
    nonce: h.get("x-nonce") ?? undefined,
    site: isSitePath(h.get("x-zv-path")),
    cookie: h.get("cookie"),
    path: h.get("x-zv-path"),
    // A published site on its own domain (src/proxy.ts): no zvena cookie banner there.
    customDomain: Boolean(h.get(SITE_HOST_HEADER)),
  };
}

export async function generateMetadata(): Promise<Metadata> {
  const { locale } = await requestLocale();
  const tagline = translate(locale, "brand.tagline");
  const title = `zvena — ${tagline.charAt(0).toLowerCase()}${tagline.slice(1)}`;
  const description = translate(locale, "landing.lead");
  return {
    title: { default: title, template: "%s · zvena" },
    applicationName: "zvena",
    description,
    metadataBase: new URL(config.appUrl),
    alternates: { canonical: "./" },
    openGraph: { title, description, siteName: "zvena", type: "website", images: [{ url: "/brand/icon-512.png", width: 512, height: 512, alt: "zvena" }], ...(locale === "ru" ? {} : { locale: "en_US" }) },
    twitter: { card: "summary", title, description },
    robots: config.isTestStand ? { index: false, follow: false } : undefined,
    formatDetection: { email: false, address: false, telephone: false },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Android Chrome: the on-screen keyboard shrinks the layout (as iOS does), so
  // bottom bars and composers stay above it instead of under it.
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#2c2c2c" },
  ],
};

// Before the first paint: the theme (light / dark / system) and, for
// Documents, the sidebar's stored width — no flash of the wrong look.
const THEME_INIT = `(function(){try{var s=null;try{s=JSON.parse(localStorage.getItem("zvena-settings")||"null")}catch(e){}var t=s&&s.theme;var d=t==="dark"||((!t||t==="system")&&window.matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;r.classList.toggle("dark",d);r.style.colorScheme=d?"dark":"light";}catch(e){}})();${SHELL_RESTORE}`;

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const { locale, nonce, site, cookie, path, customDomain } = await requestLocale();
  // Whose page this is, for the offline copy (public/sw.js). The public site,
  // a site on its own domain and the offline page have none (the worker keeps
  // one copy for everyone).
  const scope = site || customDomain || path === "/offline" ? null : swScope(cookie);
  return (
    <html lang={locale} dir={dirOf(locale)} suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="light dark" />
        {scope && <meta name="zv-scope" content={scope} />}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body className={site ? "zs" : undefined}>
        <I18nProvider initialLocale={locale} messages={locale === "en" || locale === "ru" ? undefined : { web: messagesOf("web", locale), eco: messagesOf("eco", locale), ds: messagesOf("ds", locale) }}>
          {config.isTestStand && <aside className="zv-stand" aria-label={translate(locale, "common.testStand")}>{translate(locale, "common.testStand")}</aside>}
          {children}
          {!customDomain && <CookieNotice text={translate(locale, "cookie.text")} more={translate(locale, "cookie.more")} ok={translate(locale, "cookie.ok")} />}
          {scope && <ServiceWorker scope={scope} />}
        </I18nProvider>
      </body>
    </html>
  );
}
