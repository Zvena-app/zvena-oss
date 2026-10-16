// Shared per-IP sliding-window rate limiter (50 req/min default).
// In-process Map: correct for the single-instance deployment. If the app is
// ever scaled horizontally, move this to Redis/Valkey.

const WINDOW_MS = 60_000;
const buckets = new Map<string, number[]>();
let lastSweep = 0;

function sweep(now: number): void {
  if (buckets.size < 2000 && now - lastSweep < 5 * 60_000) return;
  lastSweep = now;
  for (const [k, v] of buckets) {
    const fresh = v.filter((t) => now - t < WINDOW_MS);
    if (fresh.length) buckets.set(k, fresh);
    else buckets.delete(k);
  }
}

/** Best-effort client IP behind Cloudflare/nginx. Spoofable — defense in depth only. */
export function clientIp(req: Request): string {
  const h = req.headers;
  // nginx overwrites X-Real-IP with $remote_addr (unspoofable). Trust
  // CF-Connecting-IP only when the TCP peer is a Cloudflare edge; direct
  // origin hits must rate-limit by their real peer IP, not a spoofed header.
  const real = h.get("x-real-ip")?.trim();
  if (real && !isCloudflareIp(real)) return real;
  const cf = h.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  if (real) return real;
  const fwd = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || "unknown";
}

// Cloudflare edge IPv4 ranges (https://www.cloudflare.com/ips-v4). IPv6
// edges are rare for this deployment; unknown families fall back safely.
const CF_CIDRS: [number, number][] = (() => {
  const toInt = (ip: string) => ip.split(".").reduce((a, p) => (a << 8) + Number(p), 0) >>> 0;
  return [
    "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "104.16.0.0/13",
    "104.24.0.0/14", "108.162.192.0/18", "131.0.72.0/22", "141.101.64.0/18",
    "162.158.0.0/15", "172.64.0.0/13", "173.245.48.0/20", "188.114.0.0/20",
    "190.93.240.0/20", "197.234.240.0/22", "198.41.128.0/17",
  ].map((c) => {
    const [ip, bits] = c.split("/");
    const base = toInt(ip);
    const mask = bits === "0" ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return [base & mask, mask] as [number, number];
  });
})();

function isCloudflareIp(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return false;
  const n = parts.reduce((a, p) => (a << 8) + Number(p), 0) >>> 0;
  return CF_CIDRS.some(([base, mask]) => (n & mask) === base);
}

export interface RateCheck {
  ok: boolean;
  retryAfter: number;
}

/** Sliding-window check. Returns ok:false with retry-after seconds when over limit. */
export function checkRate(req: Request, scope: string, limit = 50): RateCheck {
  const now = Date.now();
  sweep(now);
  const key = `${scope}:${clientIp(req)}`;
  const arr = (buckets.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= limit) {
    buckets.set(key, arr);
    const retryAfter = Math.max(1, Math.ceil((arr[0] + WINDOW_MS - now) / 1000));
    return { ok: false, retryAfter };
  }
  arr.push(now);
  buckets.set(key, arr);
  return { ok: true, retryAfter: 0 };
}

/** Per-scope per-minute budgets per client IP. IPs live only in this
 * in-process map for a minute: they are never written to disk or logs. */
const SCOPE_LIMITS: Record<string, number> = {
  "notes-sync": 240,
  "notes-upload": 60,
  "notes-share": 30,
  "notes-form": 20,
  "notes-unfurl": 30,
  "notes-presence": 120,
  "notes-button": 60,
  // The Web Clipper and share sheets: a clip downloads pictures, so it is dear.
  "notes-clip": 30,
  "clipper": 120,
  "clipper-token": 20,
  // Co-editing: a typist sends a batch every ~80 ms; the stream reconnects rarely.
  "notes-collab": 1500,
  "notes-collab-open": 60,
  "share-read": 120,
  "auth-start": 20,
  "auth-callback": 30,
  "auth-dev": 10,
  "auth-onetap": 20,
  "auth-email": 6,
  "auth-email-verify": 20,
  "auth-session": 120,
  "auth-account": 10,
  "auth-logout": 30,
  "export": 3,
  "report": 10,
  "ws": 60,
  "ws-invite": 30,
  "design": 120,
  "design-preview": 240,
  "maps-tile": 900,
  "maps-geo": 30,
  "admin": 120,
};

export function rateLimited(req: Request, scope: string, limit = SCOPE_LIMITS[scope] ?? 50): Response | null {
  const c = checkRate(req, scope, limit);
  if (c.ok) return null;
  return Response.json(
    { error: "Too many requests. Please try again in a minute." },
    { status: 429, headers: { "retry-after": String(c.retryAfter) } }
  );
}
