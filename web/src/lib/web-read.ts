// Server-only page reader for link previews in Documents: opens a web page
// and returns its HTML.
//
// SSRF guard: model-chosen URLs are untrusted. Only http(s) on default
// ports. Every connection resolves its host through `safeLookup`, which
// refuses loopback/private/link-local/reserved addresses AT CONNECT TIME
// (no DNS-rebinding window between a check and the fetch). Redirects are
// followed manually (max 3), each hop re-validated the same way.
// Bounded: per-request timeout, 2 MB body cap, decompressed size cap.
import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import type { LookupFunction } from "node:net";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;

// --- Address policy ------------------------------------------------------------

function ipv4Blocked(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && p[2] === 0) ||
    (a === 192 && b === 0 && p[2] === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && p[2] === 100) ||
    (a === 203 && b === 0 && p[2] === 113) ||
    a >= 224
  );
}

/** True for any address a server-side fetch must never reach. */
export function isBlockedAddress(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) return ipv4Blocked(ip);
  if (fam !== 6) return true;
  const s = ip.toLowerCase();
  if (s === "::" || s === "::1") return true;
  // IPv4-mapped / translated forms carry an IPv4 address: judge that one.
  const mapped = /(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return ipv4Blocked(mapped[1]);
  // Any other form that carries an IPv4 address (::ffff:0:a.b.c.d, 64:ff9b::a.b.c.d…) is refused outright.
  if (/\d+\.\d+\.\d+\.\d+$/.test(s)) return true;
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(s) || /^::ffff:0:/.test(s)) return true;
  // 6to4 (2002::/16) and Teredo (2001:0::/32) tunnel to IPv4 addresses.
  if (s.startsWith("2002:") || /^2001:0?:/.test(s) || s.startsWith("2001:0000:")) return true;
  const first = parseInt(s.split(":")[0] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xffc0) === 0xfec0 || // fec0::/10 site-local
    (first & 0xff00) === 0xff00 || // multicast
    s.startsWith("64:ff9b:") || // NAT64
    s.startsWith("2001:db8:") || // documentation
    s.startsWith("100::") // discard
  );
}

/** DNS lookup that refuses blocked addresses; used for every connection. */
export const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = (Array.isArray(addresses) ? addresses : []).filter((a) => !isBlockedAddress(a.address));
    if (list.length === 0) {
      const e = Object.assign(new Error(`blocked address for ${hostname}`), { code: "EBLOCKED" });
      return callback(e, "", 0);
    }
    if ((options as { all?: boolean }).all) {
      (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, list);
    } else {
      callback(null, list[0].address, list[0].family);
    }
  });
};

/** URL shape check (no I/O): http(s), default port, no credentials, not a bare IP in a blocked range. */
export function allowedUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== "80" && u.port !== "443") return null;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return null;
  if (net.isIP(host) && isBlockedAddress(host)) return null;
  return u;
}

// --- Fetch ---------------------------------------------------------------------

interface RawPage {
  status: number;
  location?: string;
  contentType: string;
  body: Buffer;
}

function getOnce(u: URL, signal: AbortSignal | undefined, timeoutMs: number, maxBytes = MAX_BYTES, accept = "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5"): Promise<RawPage> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      u,
      {
        method: "GET",
        lookup: safeLookup,
        headers: {
          "user-agent": UA,
          accept,
          "accept-language": "en-US,en;q=0.8",
          "accept-encoding": "gzip, deflate, br",
        },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers["content-type"] ?? "").toLowerCase();
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve({ status, location: String(res.headers.location), contentType, body: Buffer.alloc(0) });
          return;
        }
        const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
        let stream: NodeJS.ReadableStream = res;
        if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            resolve({ status, contentType, body: Buffer.concat(chunks) });
            return;
          }
          chunks.push(c);
        });
        stream.on("end", () => resolve({ status, contentType, body: Buffer.concat(chunks) }));
        stream.on("error", (e) => (chunks.length ? resolve({ status, contentType, body: Buffer.concat(chunks) }) : reject(e)));
      }
    );
    const onAbort = () => req.destroy(new Error("aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.on("close", () => signal?.removeEventListener("abort", onAbort));
    req.end();
  });
}

// --- HTML → readable text --------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", laquo: "«", raquo: "»", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", deg: "°", times: "×", euro: "€", pound: "£" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<(br|hr)\b[^>]*>/gi, "\n")
      .replace(/<\/(p|div|section|article|li|h[1-6]|tr|table|ul|ol|blockquote|pre|figure|figcaption|dd|dt)>/gi, "\n")
      .replace(/<(li)\b[^>]*>/gi, "\n• ")
      .replace(/<(td|th)\b[^>]*>/gi, " | ")
      // Quoted attribute values may contain ">" (Wikipedia's data-mw JSON
      // holds "<br>"): a plain <[^>]+> stopped there and leaked the rest.
      .replace(/<[a-zA-Z!/](?:[^>"']|"[^"]{0,20000}"|'[^']{0,20000}')*>/g, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Readable text of an HTML document: title + main content, boilerplate removed. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(
    (/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1] ??
      /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ??
      "").replace(/\s+/g, " ").trim()
  ).slice(0, 200);
  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|canvas|form|select|button)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|footer|header|aside)\b[\s\S]*?<\/\1>/gi, " ");
  // Prefer the article/main region when it carries the bulk of the text.
  const region = /<article\b[\s\S]*?<\/article>/i.exec(body)?.[0] ?? /<main\b[\s\S]*?<\/main>/i.exec(body)?.[0];
  if (region) {
    const regionText = stripTags(region);
    if (regionText.length > 600) body = region;
  }
  const text = stripTags(body)
    .split("\n")
    // Navigation crumbs and button labels: very short lines without a sentence end.
    .filter((l) => l.length > 2 && !(l.length < 25 && !/[.!?:;]$/.test(l) && !/\d/.test(l)))
    .join("\n");
  return { title, text };
}

export interface ReadPage {
  url: string;
  title: string;
  text: string;
}

/**
 * Opens a page and returns its readable text (null when it cannot be read:
 * blocked address, non-text type, HTTP error, timeout, empty).
 */
export async function readPage(raw: string, opts: { signal?: AbortSignal; timeoutMs?: number; maxChars?: number } = {}): Promise<ReadPage | null> {
  let u = allowedUrl(raw);
  if (!u) return null;
  const deadline = Date.now() + (opts.timeoutMs ?? 9000);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const left = deadline - Date.now();
      if (left < 300 || opts.signal?.aborted) return null;
      const r = await getOnce(u, opts.signal, left);
      if (r.location) {
        const next = allowedUrl(new URL(r.location, u).toString());
        if (!next) return null;
        u = next;
        continue;
      }
      if (r.status < 200 || r.status >= 300) return null;
      const ct = r.contentType;
      const isHtml = /text\/html|application\/xhtml/.test(ct) || (!ct && /^\s*</.test(r.body.subarray(0, 200).toString()));
      const isText = /text\/plain|text\/markdown/.test(ct);
      if (!isHtml && !isText) return null;
      const charset = /charset=([\w-]+)/.exec(ct)?.[1]?.toLowerCase();
      let src: string;
      try {
        src = new TextDecoder(charset && charset !== "utf8" ? charset : "utf-8", { fatal: false }).decode(r.body);
      } catch {
        src = r.body.toString("utf8");
      }
      const page = isHtml ? htmlToText(src) : { title: "", text: src.replace(/\s+\n/g, "\n").trim() };
      const text = page.text.slice(0, opts.maxChars ?? 20_000);
      if (text.length < 200) return null;
      return { url: u.toString(), title: page.title, text };
    }
    return null;
  } catch {
    return null;
  }
}

export interface FetchedFile {
  url: string;
  contentType: string;
  body: Buffer;
  /** The body hit the size cap and was cut. */
  truncated: boolean;
}

/**
 * Downloads a file (a PDF, an image) with the same SSRF guard as readPage:
 * safe DNS at connect time, every redirect re-validated, a size cap. Null
 * on any failure or a non-2xx answer.
 */
export async function fetchFile(raw: string, opts: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number; accept?: string } = {}): Promise<FetchedFile | null> {
  let u = allowedUrl(raw);
  if (!u) return null;
  const max = opts.maxBytes ?? 30_000_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS + 2; hop++) {
      const left = deadline - Date.now();
      if (left < 300 || opts.signal?.aborted) return null;
      const r = await getOnce(u, opts.signal, left, max + 1, opts.accept ?? "application/pdf,*/*;q=0.8");
      if (r.location) {
        const next = allowedUrl(new URL(r.location, u).toString());
        if (!next) return null;
        u = next;
        continue;
      }
      if (r.status < 200 || r.status >= 300) return null;
      const truncated = r.body.length > max;
      return { url: u.toString(), contentType: r.contentType, body: truncated ? r.body.subarray(0, max) : r.body, truncated };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Raw HTML of a page (link previews: Open Graph tags). Same guards as
 * readPage: blocked addresses, redirects re-checked, size cap, deadline.
 */
export async function readHtml(raw: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ url: string; html: string } | null> {
  let u = allowedUrl(raw);
  if (!u) return null;
  const deadline = Date.now() + (opts.timeoutMs ?? 7000);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const left = deadline - Date.now();
      if (left < 300 || opts.signal?.aborted) return null;
      const r = await getOnce(u, opts.signal, left);
      if (r.location) {
        const next = allowedUrl(new URL(r.location, u).toString());
        if (!next) return null;
        u = next;
        continue;
      }
      if (r.status < 200 || r.status >= 300) return null;
      if (r.contentType && !/text\/html|application\/xhtml/.test(r.contentType)) return null;
      const charset = /charset=([\w-]+)/.exec(r.contentType)?.[1]?.toLowerCase();
      let html: string;
      try {
        html = new TextDecoder(charset && charset !== "utf8" ? charset : "utf-8", { fatal: false }).decode(r.body.subarray(0, 600_000));
      } catch {
        html = r.body.subarray(0, 600_000).toString("utf8");
      }
      return { url: u.toString(), html };
    }
    return null;
  } catch {
    return null;
  }
}

// --- Webhooks --------------------------------------------------------------------

export interface PostResult {
  ok: boolean;
  status: number;
  error?: string;
}

/**
 * POSTs JSON to an https URL on a public address (automation webhooks): the
 * same address policy as reading, checked at connect time; no redirects are
 * followed (a 3xx is the receiver's answer); the reply is read and dropped.
 */
export function postJson(raw: string, body: unknown, opts: { timeoutMs?: number; userAgent?: string } = {}): Promise<PostResult> {
  const u = allowedUrl(raw);
  if (!u || u.protocol !== "https:") return Promise.resolve({ ok: false, status: 0, error: "blocked url" });
  const data = Buffer.from(JSON.stringify(body));
  if (data.byteLength > 512_000) return Promise.resolve({ ok: false, status: 0, error: "payload too large" });
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: PostResult) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    const req = https.request(
      u,
      {
        method: "POST",
        lookup: safeLookup,
        headers: { "content-type": "application/json; charset=utf-8", "content-length": String(data.byteLength), "user-agent": opts.userAgent ?? "zvena-webhook/1" },
        timeout: opts.timeoutMs ?? 5000,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const answer = () => finish({ ok: status >= 200 && status < 300, status, ...(status >= 200 && status < 300 ? {} : { error: `HTTP ${status}` }) });
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > 64_000) res.destroy();
        });
        res.on("end", answer);
        res.on("close", answer);
        res.on("error", answer);
      }
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", (e: Error & { code?: string }) => finish({ ok: false, status: 0, error: e.code === "EBLOCKED" ? "blocked address" : e.code === "ETIMEDOUT" ? "timeout" : "unreachable" }));
    req.end(data);
  });
}
