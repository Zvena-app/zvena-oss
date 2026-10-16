// Server-only: the frame of every /api/v1 route — Bearer auth with an
// integration secret (no cookies, so no CSRF), capability checks, a rate
// limit per integration, Notion-shaped JSON and errors, and the version
// header.

import { readBodyCapped } from "../../safe-json";
import { integrationBySecret, type Capabilities, type Integration } from "./integrations";
import { InputError } from "./richtext";
import { Space } from "./space";
import { Directory } from "./objects";

/** The API version we speak (Notion's shape of that date); a request may name its own. */
export const API_VERSION = "2022-06-28";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export const notFound = (what = "object") => new ApiError(404, "object_not_found", `Could not find ${what}. Make sure the relevant pages and databases are shared with your integration.`);
export const restricted = (msg = "Insufficient permissions for this endpoint.") => new ApiError(403, "restricted_resource", msg);

export interface ApiCtx {
  req: Request;
  integration: Integration;
  version: string;
  /** The workspace as this integration sees it (loaded on first use). */
  space(): Space;
  people(): Directory;
  /** The JSON body (capped; {} when empty). */
  body(): Promise<Record<string, unknown>>;
}

// --- Rate limit: ~3 requests a second per integration, bursts up to 10 -----------

interface Bucket {
  tokens: number;
  at: number;
}
const KEY = Symbol.for("zvena.api.buckets");
const g = globalThis as unknown as Record<symbol, Map<string, Bucket> | undefined>;
const buckets: Map<string, Bucket> = (g[KEY] ??= new Map());
const RATE = 3;
const BURST = 10;

/** Takes a token; returns the seconds to wait when there is none. */
export function takeToken(id: string, now = Date.now()): number {
  const b = buckets.get(id) ?? { tokens: BURST, at: now };
  b.tokens = Math.min(BURST, b.tokens + ((now - b.at) / 1000) * RATE);
  b.at = now;
  if (b.tokens < 1) {
    buckets.set(id, b);
    return Math.max(1, Math.ceil((1 - b.tokens) / RATE));
  }
  b.tokens -= 1;
  buckets.set(id, b);
  return 0;
}

/** Test hook: an empty bucket for an integration. */
export function resetRate(id?: string): void {
  if (id) buckets.delete(id);
  else buckets.clear();
}

function respond(status: number, body: unknown, version: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "zvena-version": version, "x-content-type-options": "nosniff", ...extra },
  });
}

export function errorResponse(e: unknown, version = API_VERSION): Response {
  if (e instanceof ApiError) return respond(e.status, { object: "error", status: e.status, code: e.code, message: e.message }, version);
  if (e instanceof InputError) return respond(400, { object: "error", status: 400, code: "validation_error", message: e.message }, version);
  console.error(`[api] ${e instanceof Error ? e.name : "error"}`);
  return respond(500, { object: "error", status: 500, code: "internal_server_error", message: "Unexpected error." }, version);
}

const BODY_LIMIT = 1_000_000;

type Need = keyof Omit<Capabilities, "users"> | "users" | null;

/** Wraps a route handler: auth, capability, rate limit, errors. */
export function apiRoute<P = Record<string, string>>(need: Need, handler: (ctx: ApiCtx, params: P) => Promise<unknown> | unknown) {
  return async (req: Request, route?: { params: Promise<P> }): Promise<Response> => {
    const version = (req.headers.get("zvena-version") || req.headers.get("notion-version") || API_VERSION).slice(0, 20);
    try {
      const auth = req.headers.get("authorization") ?? "";
      const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1] ?? "";
      const integration = token ? integrationBySecret(token) : null;
      if (!integration) throw new ApiError(401, "unauthorized", "API token is invalid.");
      const wait = takeToken(integration.id);
      if (wait > 0) return respond(429, { object: "error", status: 429, code: "rate_limited", message: "This request exceeds the number of requests allowed. Slow down and try again." }, version, { "retry-after": String(wait) });
      if (need === "users" && integration.caps.users === "none") throw restricted("This integration may not read user information.");
      if (need && need !== "users" && !integration.caps[need]) throw restricted(`This integration does not have the ${need} capability.`);
      let space: Space | null = null;
      let people: Directory | null = null;
      let body: Promise<Record<string, unknown>> | null = null;
      const ctx: ApiCtx = {
        req,
        integration,
        version,
        space: () => {
          if (!space) {
            space = Space.load(integration);
            space.version = version;
          }
          return space;
        },
        people: () => (people ??= new Directory(integration)),
        body: () =>
          (body ??= (async () => {
            if (req.method === "GET" || req.method === "DELETE") return {};
            const raw = await readBodyCapped(req, BODY_LIMIT);
            if (!raw.ok) throw raw.status === 413 ? new ApiError(413, "validation_error", "Request body too large.") : new ApiError(400, "invalid_json", "The request body could not be read.");
            const text = new TextDecoder().decode(raw.bytes);
            // An empty body reads as {}; anything else must be a JSON object.
            if (!text.trim()) return {};
            let value: unknown;
            try {
              value = JSON.parse(text);
            } catch {
              throw new ApiError(400, "invalid_json", "Error parsing JSON body.");
            }
            if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ApiError(400, "invalid_json", "The request body should be a JSON object.");
            return value as Record<string, unknown>;
          })()),
      };
      const params = route ? await route.params : ({} as P);
      const out = await handler(ctx, params);
      return out instanceof Response ? out : respond(200, out, version);
    } catch (e) {
      return errorResponse(e, version);
    }
  };
}

/** Browsers get no CORS grant: the API is for servers holding a secret. */
export function preflight(): Response {
  return new Response(null, { status: 204, headers: { allow: "GET, POST, PATCH, DELETE" } });
}
