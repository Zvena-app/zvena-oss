import { NextResponse, type NextRequest } from "next/server";
import { hostOnly, hostRoutingOn, isFirstPartyHost, SITE_HOST_HEADER, siteRoute } from "@/lib/enterprise/hosts";

// Security headers for every page (nginx repeats the static ones in production).
//
// Content-Security-Policy with a fresh nonce per request: only our own
// scripts run ('strict-dynamic' lets them load our chunks). connect-src is
// 'self' only — the browser itself refuses to send data to any other host,
// so no tracker or external (AI or any other) service can be reached from
// the app, even by a bug. Documents may embed https pages (YouTube, maps…)
// in sandboxed frames and show https images.
//
// Hosts (lib/enterprise/hosts.ts): a request for a host that is not zvena's
// own is a published site's custom domain. It gets that site's pages, its
// robots.txt and sitemap, and the files those pages load — never the rest of
// the app: no cookies reach the app (the Cookie and Authorization headers
// are dropped), every other path is a plain 404. Which domain is verified,
// and for which site, the page itself looks up (the header SITE_HOST_HEADER,
// which the proxy alone sets: an incoming one is always dropped).

const DOC_PATHS = /^\/(docs|n\/|templates)/;
// Mail shows each message in a sandboxed frame of its own (/api/mail/body/…, with its own CSP).
const MAIL_PATHS = /^\/mail(\/|$)/;
// Sign-in forms whose answer may redirect to a workspace's identity provider
// (single sign-on, lib/enterprise/sso.ts): any HTTPS origin, since form-action
// also governs the redirects after a form is sent (plain HTTP on a test stand,
// for its mock provider).
const SSO_PATHS = /^\/(signin(\/.*)?|api\/sso\/start)$/;

const designOrigin = (() => {
  try {
    return new URL(process.env.DESIGN_URL || "").origin;
  } catch {
    return "";
  }
})();

function policy(nonce: string, o: { dev: boolean; docs: boolean; sso?: boolean; mail?: boolean }): string {
  return [
    "default-src 'self'",
    // The host is for browsers without 'strict-dynamic' (with it, the script our code inserts is trusted).
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${o.dev ? " 'unsafe-eval'" : ""}`,
    // Style attributes (the editor positions menus with them); no external sheets.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    o.docs ? "media-src 'self' blob: data: https:" : "media-src 'self' blob: data:",
    "worker-src 'self' blob:",
    `connect-src 'self'${o.dev ? " ws:" : ""}`,
    "font-src 'self' data:",
    // Mail shows each message in a sandboxed frame of its own origin (src/app/api/mail/body).
    o.docs ? "frame-src 'self' https:" : o.mail ? "frame-src 'self'" : "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    // Sign-in and consent forms post here; their redirects may continue to
    // Design (its OIDC sign-in), which form-action also governs.
    `form-action 'self'${designOrigin ? ` ${designOrigin}` : ""}${o.sso ? ` https:${o.dev || process.env.ZVENA_STAND === "test" ? " http:" : ""}` : ""}`,
    ...((process.env.APP_URL || "").startsWith("https://") ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

function secure(res: NextResponse, csp: string, o: { dev: boolean; docs: boolean; site: boolean }): NextResponse {
  res.headers.set("Content-Security-Policy", csp);
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  // Documents may ask for the location once ("Use current location" of a Place property).
  res.headers.set("Permissions-Policy", `camera=(), microphone=(), geolocation=${o.docs && !o.site ? "(self)" : "()"}, payment=(), usb=(), interest-cohort=(), browsing-topics=()`);
  // A customer's domain gets HSTS for itself only (its other subdomains are not ours to pin).
  if (!o.dev) res.headers.set("Strict-Transport-Security", o.site ? "max-age=31536000" : "max-age=63072000; includeSubDomains");
  // The test stand is never indexed.
  if (process.env.ZVENA_STAND === "test") res.headers.set("X-Robots-Tag", "noindex, nofollow");
  return res;
}

/** A custom domain's request: the site, or 404. */
function siteProxy(req: NextRequest, host: string, dev: boolean): NextResponse {
  const route = siteRoute(req.nextUrl.pathname);
  if (route.kind === "deny") {
    return new NextResponse("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  }
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const o = { dev, docs: true, site: true };
  const csp = policy(nonce, o);
  const reqHeaders = new Headers(req.headers);
  // Nothing of a zvena session may reach the app through someone's domain.
  reqHeaders.delete("cookie");
  reqHeaders.delete("authorization");
  reqHeaders.set(SITE_HOST_HEADER, host);
  reqHeaders.set("x-nonce", nonce);
  reqHeaders.set("x-zv-path", route.kind === "rewrite" ? route.to : req.nextUrl.pathname);
  reqHeaders.set("Content-Security-Policy", csp);
  // The rewrite itself is next.config.ts's (it matches the header set here): a
  // rewrite from here to an absolute URL would leave the server whenever the
  // host it names differs from the one Next.js listens on.
  return secure(NextResponse.next({ request: { headers: reqHeaders } }), csp, o);
}

export function proxy(req: NextRequest) {
  const dev = process.env.NODE_ENV !== "production";
  const host = req.headers.get("host") ?? "";
  if (hostRoutingOn() && !isFirstPartyHost(host, process.env.APP_URL || "http://localhost:3100", process.env.ZVENA_APP_HOSTS)) return siteProxy(req, hostOnly(host), dev);
  const reqHeaders = new Headers(req.headers);
  reqHeaders.delete(SITE_HOST_HEADER);
  // Prefetches reach the proxy only to have a forged site header dropped (they need no policy of their own).
  if (req.headers.has("next-router-prefetch") || req.headers.get("purpose") === "prefetch") return NextResponse.next({ request: { headers: reqHeaders } });
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const docs = DOC_PATHS.test(req.nextUrl.pathname);
  const o = { dev, docs, site: false, sso: SSO_PATHS.test(req.nextUrl.pathname), mail: MAIL_PATHS.test(req.nextUrl.pathname) };
  const csp = policy(nonce, o);
  reqHeaders.set("x-nonce", nonce);
  // The root layout styles the public site (lib/site.ts) apart from the app.
  reqHeaders.set("x-zv-path", req.nextUrl.pathname);
  reqHeaders.set("Content-Security-Policy", csp);
  return secure(NextResponse.next({ request: { headers: reqHeaders } }), csp, o);
}

// Files placed in documents carry their own sandboxed policy. Uploads,
// sync and publishing skip the proxy too: Next.js would cut a request body
// that passes through it at 10 MB (proxyClientMaxBodySize), and these
// routes take up to 50 MB (they cap their bodies themselves); on a custom
// domain they answer 404 themselves (onForeignHost). Mail's message frames,
// images and attachments carry their own policy, and its uploads cap their
// own bodies. Prefetches come through
// (the second and third entries) only so that no forged site header passes.
// (Matcher values must be literals: Next.js reads them at build time.)

export const config = {
  matcher: [
    {
      source: "/((?!api/notes/(?:file/|upload|sync|share)|api/mail/(?:body/|img|att/|upload)|_next/static|_next/image|favicon.ico|fonts/).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
    { source: "/((?!api/notes/(?:file/|upload|sync|share)|api/mail/(?:body/|img|att/|upload)|_next/static|_next/image|favicon.ico|fonts/).*)", has: [{ type: "header", key: "next-router-prefetch" }] },
    { source: "/((?!api/notes/(?:file/|upload|sync|share)|api/mail/(?:body/|img|att/|upload)|_next/static|_next/image|favicon.ico|fonts/).*)", has: [{ type: "header", key: "purpose", value: "prefetch" }] },
  ],
};
