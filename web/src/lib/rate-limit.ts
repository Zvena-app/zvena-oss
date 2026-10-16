// Shared per-IP sliding-window rate limiter (50 req/min default).
// In-process Map: correct for the single-instance deployment. If the app is
// ever scaled horizontally, move this to Redis/Valkey.

const WINDOW_MS = 60_000;
const buckets = new Map<string, number[]>();
let lastSweep = 0;

function sweep(now: number): void {
  // Every few minutes; with many keys every 10 s (never a full walk on each request).
  if (now - lastSweep < (buckets.size < 2000 ? 5 * 60_000 : 10_000)) return;
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

// Cloudflare edge IPv4 ranges (https://www.cloudflare.com/ips-v4); IPv6 below.
const CF_CIDRS: [number, number][] = (() => {
  const toInt = (ip: string) => ip.split(".").reduce((a, p) => (a << 8) + Number(p), 0) >>> 0;
  return [
    "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "104.16.0.0/13",
    "104.24.0.0/14", "108.162.192.0/18", "131.0.72.0/22", "141.101.64.0/18",
    "162.158.0.0/15", "172.64.0.0/13", "173.245.48.0/20", "188.114.96.0/20",
    "190.93.240.0/20", "197.234.240.0/22", "198.41.128.0/17",
  ].map((c) => {
    const [ip, bits] = c.split("/");
    const base = toInt(ip);
    const mask = bits === "0" ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return [base & mask, mask] as [number, number];
  });
})();

// Cloudflare edge IPv6 ranges (https://www.cloudflare.com/ips-v6), as [prefix hextets, bits].
const CF_V6: [number[], number][] = [
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
  "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
].map((c) => {
  const [ip, bits] = c.split("/");
  return [ipv6Hextets(ip) as number[], Number(bits)];
});

/** The eight 16-bit groups of an IPv6 address (IPv4-mapped tails included), or null. */
export function ipv6Hextets(ip: string): number[] | null {
  let s = ip.trim().toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(":") || s.length > 45) return null;
  let tail: number[] = [];
  const v4 = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const b = v4.slice(2).map(Number);
    if (b.some((x) => x > 255)) return null;
    tail = [(b[0] << 8) | b[1], (b[2] << 8) | b[3]];
    s = v4[1].endsWith("::") ? v4[1] : v4[1].slice(0, -1);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const read = (part: string) => (part ? part.split(":") : []).map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  const head = read(halves[0]);
  const rest = halves.length === 2 ? read(halves[1]) : [];
  const fill = 8 - tail.length - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const out = [...head, ...Array(halves.length === 2 ? fill : 0).fill(0), ...rest, ...tail];
  return out.length === 8 && out.every((x) => Number.isInteger(x)) ? out : null;
}

/**
 * The address a limit counts by: an IPv4 address as is, an IPv6 address by
 * its /64 (one subscriber gets a whole /64, so per-address buckets would be
 * free to rotate through), an IPv4-mapped one as its IPv4 address.
 */
export function ipKey(ip: string): string {
  const h = ipv6Hextets(ip);
  if (!h) return ip;
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return `${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`;
  return `${h.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

/** The client's limiter key (see ipKey): for per-client counters kept elsewhere. */
export function clientKey(req: Request): string {
  return ipKey(clientIp(req));
}

function inPrefix(h: number[], p: number[], bits: number): boolean {
  for (let i = 0; i < 8 && bits > i * 16; i++) {
    const n = Math.min(16, bits - i * 16);
    const mask = (0xffff << (16 - n)) & 0xffff;
    if (((h[i] ^ p[i]) & mask) !== 0) return false;
  }
  return true;
}

function isCloudflareIp(ip: string): boolean {
  const h6 = ipv6Hextets(ip);
  if (h6) return CF_V6.some(([p, bits]) => inPrefix(h6, p, bits));
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
  const key = `${scope}:${clientKey(req)}`;
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
