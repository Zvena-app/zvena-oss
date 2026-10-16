// Host names: which requests are zvena itself and which come to a published
// site's custom domain (Notion Sites → Custom domain). Pure, no I/O: the
// request proxy (src/proxy.ts) imports it.
//
// zvena's own hosts are APP_URL's host (and its www.), ZVENA_APP_HOSTS
// (comma-separated, e.g. a stand's address), IP literals, "localhost" and
// one-label names (containers calling each other: http://web:3100). Every
// other host is foreign: it may only be a verified custom domain, and then
// it serves that site's pages and nothing else of the app.

/** The request header that tells a page it is served on a custom domain (set by the proxy only; any incoming one is dropped). */
export const SITE_HOST_HEADER = "x-zv-site-host";
/** The page id a custom domain's root is rewritten to (never a real share id: those have no "_"). */
export const SITE_ROOT_ID = "_site";

/** "Docs.Example.com:443." → "docs.example.com"; "[::1]:3100" → "::1"; "" when unusable. */
export function hostOnly(raw: string | null | undefined): string {
  let h = String(raw ?? "").trim().toLowerCase();
  if (!h || h.length > 300) return "";
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 1 ? h.slice(1, end) : "";
  }
  // One colon: host:port. More than one: a bare IPv6 address.
  if ((h.match(/:/g) ?? []).length === 1) h = h.slice(0, h.indexOf(":"));
  return h.replace(/\.+$/, "");
}

function isIpLiteral(h: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || (h.includes(":") && /^[0-9a-f:.]+$/.test(h));
}

function appHostOf(appUrl: string): string {
  try {
    return hostOnly(new URL(appUrl).host);
  } catch {
    return "";
  }
}

/** zvena's own hosts besides IP literals and one-label names. */
export function firstPartyHosts(appUrl: string, extra: string | undefined): Set<string> {
  const out = new Set<string>();
  const app = appHostOf(appUrl);
  if (app) {
    out.add(app);
    if (!app.startsWith("www.") && !isIpLiteral(app)) out.add(`www.${app}`);
  }
  for (const h of String(extra ?? "").split(",")) {
    const x = hostOnly(h);
    if (x) out.add(x);
  }
  return out;
}

/** Whether the Host is zvena itself (true) or someone's domain (false). */
export function isFirstPartyHost(host: string, appUrl: string, extra?: string): boolean {
  const h = hostOnly(host);
  if (!h) return true;
  if (isIpLiteral(h) || !h.includes(".") || h === "localhost" || h.endsWith(".localhost")) return true;
  return firstPartyHosts(appUrl, extra).has(h);
}

/** Host routing can be switched off (ZVENA_SITES_HOST_ROUTING=off): every host is then zvena's, as before custom domains. */
/**
 * Custom domains for Sites are offered at all (ZVENA_SITES_CUSTOM_DOMAINS=on):
 * only where the server can serve them — Caddy's on-demand TLS asking
 * /api/sites/domain-check, and DNS for the CNAME target. Off (the default):
 * no Settings section, the routes answer 404, no host is a site.
 */
export function customDomainsOn(): boolean {
  return process.env.ZVENA_SITES_CUSTOM_DOMAINS === "on";
}

export function hostRoutingOn(): boolean {
  return process.env.ZVENA_SITES_HOST_ROUTING !== "off";
}

/** Whether a request came to a foreign host (a custom domain) — for routes the proxy does not see. */
export function onForeignHost(req: Request): boolean {
  return hostRoutingOn() && !isFirstPartyHost(req.headers.get("host") ?? "", process.env.APP_URL || "http://localhost:3100", process.env.ZVENA_APP_HOSTS);
}

/**
 * What a custom domain may serve, by path: the site itself at "/", its
 * robots.txt and sitemap.xml (rewritten to `to` by next.config.ts, which
 * matches the header the proxy sets), the browser's assets, and the few
 * public endpoints a published page loads (its uploaded files and map
 * tiles). Everything else is answered 404 by the proxy.
 */
export type SiteRoute = { kind: "rewrite"; to: string } | { kind: "pass" } | { kind: "deny" };

export function siteRoute(pathname: string): SiteRoute {
  if (pathname === "/") return { kind: "rewrite", to: `/n/${SITE_ROOT_ID}` };
  if (pathname === "/robots.txt") return { kind: "rewrite", to: "/api/sites/robots" };
  if (pathname === "/sitemap.xml") return { kind: "rewrite", to: "/api/sites/sitemap" };
  if (/^\/_next\/(static|image)\//.test(pathname)) return { kind: "pass" };
  if (/^\/(brand|fonts|vendor)\/[\w./-]+$/.test(pathname) && !pathname.includes("..")) return { kind: "pass" };
  if (pathname === "/favicon.ico" || pathname === "/icon.svg" || pathname === "/apple-icon.png") return { kind: "pass" };
  if (/^\/api\/notes\/file\/[a-f0-9]{40}\.[a-z0-9]{1,8}$/.test(pathname)) return { kind: "pass" };
  if (/^\/api\/maps\/tile\/\d{1,2}\/\d{1,7}\/\d{1,7}\.png$/.test(pathname)) return { kind: "pass" };
  return { kind: "deny" };
}

/**
 * A custom domain someone types: lower-cased, IDN as punycode, at least two
 * labels, letters/digits/hyphens. Returns null when it is not a usable host
 * name (an IP address, a URL with a path, a single label…).
 */
export function normalizeDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim().toLowerCase();
  if (!s || s.length > 300) return null;
  s = s.replace(/^https?:\/\//, "").replace(/\.+$/, "");
  if (/[/?#@:\s\\]/.test(s)) return null;
  let host: string;
  try {
    host = new URL(`http://${s}`).hostname;
  } catch {
    return null;
  }
  if (host.length < 4 || host.length > 253 || isIpLiteral(host)) return null;
  const labels = host.split(".");
  if (labels.length < 2) return null;
  for (const l of labels) if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) return null;
  if (/^\d+$/.test(labels[labels.length - 1])) return null;
  return host;
}

/** Whether `host` is `base` or under it ("docs.example.com" is under "example.com"). */
export function isSameOrSub(host: string, base: string): boolean {
  return Boolean(base) && (host === base || host.endsWith(`.${base}`));
}
