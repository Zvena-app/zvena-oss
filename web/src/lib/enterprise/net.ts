// Server-only: the one way enterprise code talks to an identity provider the
// workspace owner named (OIDC discovery, keys, the token endpoint). The URL
// is untrusted: HTTPS only, every connection resolved through web-read's
// safeLookup (no loopback, private or link-local address, no DNS-rebinding
// window), no redirects followed, 10 s and 1 MB at most. A test stand may
// also reach plain-HTTP and local providers (its mock identity provider).

import http from "node:http";
import https from "node:https";
import { config } from "../config";
import { allowedUrl, safeLookup } from "../web-read";

const MAX_BYTES = 1_000_000;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: unknown; signal?: AbortSignal }) => Promise<Response>;

let override: FetchLike | null = null;
/** Tests talk to their own provider. */
export function setIdpFetchForTests(f: FetchLike | null): void {
  override = f;
}

function bodyBuffer(body: unknown): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
  throw new Error("unsupported body");
}

export const idpFetch: FetchLike = (url, init) => {
  if (override) return override(url, init);
  const local = config.isTestStand;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return Promise.reject(new Error("bad url"));
  }
  if (!local && (u.protocol !== "https:" || !allowedUrl(url))) return Promise.reject(new Error("refused url"));
  if (u.protocol !== "https:" && u.protocol !== "http:") return Promise.reject(new Error("refused url"));
  const payload = bodyBuffer(init.body);
  return new Promise<Response>((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      u,
      {
        method: init.method,
        headers: { ...init.headers, ...(payload ? { "content-length": String(payload.length) } : {}), "user-agent": `zvena-sso (+${config.appUrl})` },
        ...(local ? {} : { lookup: safeLookup }),
        timeout: 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) {
            req.destroy(new Error("response too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") headers.set(k, v);
            else if (Array.isArray(v)) for (const x of v) headers.append(k, x);
          }
          const status = res.statusCode ?? 502;
          resolve(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), { status, headers }));
        });
        res.on("error", reject);
      }
    );
    const onAbort = () => req.destroy(new Error("aborted"));
    init.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.on("close", () => init.signal?.removeEventListener("abort", onAbort));
    req.end(payload);
  });
};
