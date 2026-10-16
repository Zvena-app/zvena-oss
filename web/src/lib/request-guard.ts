/**
 * Same-origin guard for cookie-authenticated state-changing routes.
 *
 * Session cookies are SameSite=Lax, which still allows top-level navigation
 * GETs — but a cross-site POST/DELETE issued by a browser always carries an
 * Origin (fetch/form) or Referer that does NOT match our origin. Rejecting
 * those kills CSRF (malicious logout-all, account delete, inventory writes)
 * while API clients without those headers (curl, cron) keep working.
 *
 * Framework-free: the caller passes the expected origin (requestSelfOrigin).
 */

function hostOf(origin: string): string {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Same-site comparison: host (+port) must match, scheme is ignored.
 * The site sits behind a TLS-terminating proxy (Cloudflare → nginx over
 * plain HTTP), so the backend routinely sees `http://example.com`
 * while the browser sends `Origin: https://example.com`. Rejecting on
 * scheme mismatch 403s every real user POST (observed live: all /api/chat
 * from the public origin returned `{"error":"forbidden origin"}`). An
 * attacker's origin never shares our host, so host comparison keeps the
 * full CSRF value without the false positives.
 */
function originsSameSite(a: string, b: string): boolean {
  const ha = hostOf(a);
  const hb = hostOf(b);
  return ha !== "" && ha === hb;
}

/**
 * The origin of the incoming request itself (proxy-aware). Compared against
 * the request — not the canonical APP_URL — so dev hosts, direct-IP access
 * and alternate first-party hosts keep working; only a *different* origin
 * (a third-party page driving the browser) is rejected.
 */
export function requestSelfOrigin(req: Request): string {
  const h = req.headers;
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").trim();
  if (!host) return "";
  // Cloudflare preserves the client-facing scheme in CF-Visitor; nginx
  // overwrites X-Forwarded-Proto with the origin-side scheme (plain HTTP),
  // so prefer CF-Visitor, then the first entry of a proto chain.
  const cfVisitor = h.get("cf-visitor")?.trim();
  if (cfVisitor) {
    try {
      const scheme = (JSON.parse(cfVisitor) as { scheme?: unknown }).scheme;
      if (scheme === "http" || scheme === "https") {
        return new URL(`${scheme}://${host}`).origin;
      }
    } catch {
      // Malformed header — fall through to the proto chain.
    }
  }
  const protoChain = (h.get("x-forwarded-proto") ?? "").split(",")[0]?.trim();
  const proto =
    protoChain ||
    (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host) ? "http" : "https");
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return "";
  }
}

export function rejectCrossSiteWrite(req: Request, origin: string): { status: 403 } | null {
  const o = (req.headers.get("origin") || "").trim();
  if (o) {
    return originsSameSite(o, origin) ? null : { status: 403 };
  }
  const ref = (req.headers.get("referer") || "").trim();
  if (ref) {
    try {
      if (originsSameSite(new URL(ref).origin, origin)) return null;
    } catch {
      return { status: 403 };
    }
    return { status: 403 };
  }
  return null;
}
