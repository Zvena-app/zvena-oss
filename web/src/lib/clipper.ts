// Server-only: the Web Clipper's connection to an account.
//
// The browser extension never uses the site's session cookie. "Connect"
// opens /clipper/connect in a tab; the signed-in person allows it there,
// which gives a one-time code (2 minutes, bound to the extension's PKCE
// challenge); the extension trades it with its verifier for a clipper
// token. The token is scoped: it lists where pages can be added and adds
// them (lib/notes/clip.ts), nothing else — no reading of pages, no other
// API. Tokens and codes are kept only as HMACs, last a year, are revoked
// one by one in Settings (Connected apps) or all at once with "Sign out of
// all devices".
//
// Why not the cookie: a cookie-authenticated endpoint that accepted
// extension origins would have to relax the same-origin CSRF check (the
// Origin of an extension's request is chrome-extension:// or a random
// moz-extension://), and an extension holding the cookie would carry the
// whole session's authority; Firefox and Safari also partition cookies for
// extension requests. A token is least privilege and can be revoked alone.

import { createHash, randomBytes } from "node:crypto";
import { getUser, mac, safeEqual, type AuthUser } from "./auth";
import { audit, sql, store, tx } from "./store";

const CODE_TTL = 2 * 60_000;
const TOKEN_TTL = 365 * 86_400_000;
const MAX_TOKENS = 20;

export const CLIPPER_CLIENTS = ["chrome", "edge", "firefox", "safari", "other"] as const;
export type ClipperClient = (typeof CLIPPER_CLIENTS)[number];

export const STATE_RE = /^[A-Za-z0-9_-]{22,64}$/;
/** base64url(SHA-256(verifier)) without padding. */
export const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const CODE_RE = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_RE = /^zvc_[A-Za-z0-9_-]{43}$/;

const ready = new WeakSet<object>();

/** The clipper's tables, created on first use (this module stays self-contained, like lib/notes/api/schema.ts). */
function tables(): void {
  const d = store();
  if (ready.has(d)) return;
  d.exec(`
CREATE TABLE IF NOT EXISTS clipper_codes (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, challenge TEXT NOT NULL, client TEXT NOT NULL, exp INTEGER NOT NULL);
-- hash: HMAC of the token (the token itself lives only in the extension).
CREATE TABLE IF NOT EXISTS clipper_tokens (id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, client TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, exp INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS clipper_tokens_user ON clipper_tokens(user_id);
`);
  ready.add(d);
}

export function cleanClient(v: unknown): ClipperClient {
  return typeof v === "string" && (CLIPPER_CLIENTS as readonly string[]).includes(v) ? (v as ClipperClient) : "other";
}

/** base64url(SHA-256(verifier)): what the extension sent as its challenge. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** A one-time code for the extension that asked with `challenge` (the person pressed Allow). */
export function issueClipperCode(userId: string, challenge: string, client: ClipperClient, now = Date.now()): string {
  tables();
  if (!CHALLENGE_RE.test(challenge)) throw new Error("bad challenge");
  const code = randomBytes(32).toString("base64url");
  sql("DELETE FROM clipper_codes WHERE exp < ?").run(now);
  sql("INSERT INTO clipper_codes (hash, user_id, challenge, client, exp) VALUES (?, ?, ?, ?, ?)").run(mac("clip-code", code), userId, challenge, client, now + CODE_TTL);
  return code;
}

export interface IssuedToken {
  token: string;
  id: string;
  user: AuthUser;
  expiresAt: number;
}

/**
 * Trades a code for a token: once (the code is gone whatever happens), in
 * time, and only with the verifier behind the code's challenge.
 */
export function redeemClipperCode(code: unknown, verifier: unknown, now = Date.now()): IssuedToken | null {
  tables();
  if (typeof code !== "string" || !CODE_RE.test(code) || typeof verifier !== "string" || !VERIFIER_RE.test(verifier)) return null;
  const hash = mac("clip-code", code);
  return tx(() => {
    const row = sql("SELECT user_id, challenge, client, exp FROM clipper_codes WHERE hash = ?").get(hash) as { user_id: string; challenge: string; client: string; exp: number } | undefined;
    if (!row) return null;
    sql("DELETE FROM clipper_codes WHERE hash = ?").run(hash);
    if (row.exp < now || !safeEqual(pkceChallenge(verifier), row.challenge)) return null;
    const user = getUser(row.user_id);
    if (!user) return null;
    const token = `zvc_${randomBytes(32).toString("base64url")}`;
    const id = randomBytes(12).toString("hex");
    const expiresAt = now + TOKEN_TTL;
    sql("INSERT INTO clipper_tokens (id, hash, user_id, client, created_at, last_used_at, exp) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, mac("clip-token", token), user.id, cleanClient(row.client), now, now, expiresAt);
    // A person keeps at most MAX_TOKENS connections (the oldest go).
    sql("DELETE FROM clipper_tokens WHERE user_id = ? AND id NOT IN (SELECT id FROM clipper_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)").run(user.id, user.id, MAX_TOKENS);
    audit(user.id, "clipper-connect", id);
    return { token, id, user, expiresAt };
  });
}

/** The account behind a clipper token (null: unknown, expired, revoked, or the account is gone or blocked). */
export function clipperUser(token: string, now = Date.now()): { user: AuthUser; tokenId: string } | null {
  tables();
  if (!TOKEN_RE.test(token)) return null;
  const row = sql("SELECT id, user_id, exp, last_used_at FROM clipper_tokens WHERE hash = ?").get(mac("clip-token", token)) as { id: string; user_id: string; exp: number; last_used_at: number | null } | undefined;
  if (!row || row.exp < now) return null;
  const user = getUser(row.user_id);
  if (!user || !user.consentOk) return null;
  if (!row.last_used_at || now - row.last_used_at > 3600_000) sql("UPDATE clipper_tokens SET last_used_at = ? WHERE id = ?").run(now, row.id);
  return { user, tokenId: row.id };
}

export interface ClipperConnection {
  id: string;
  client: ClipperClient;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number;
}

export function clipperConnections(userId: string, now = Date.now()): ClipperConnection[] {
  tables();
  const rows = sql("SELECT id, client, created_at, last_used_at, exp FROM clipper_tokens WHERE user_id = ? AND exp > ? ORDER BY created_at DESC").all(userId, now) as {
    id: string;
    client: string;
    created_at: number;
    last_used_at: number | null;
    exp: number;
  }[];
  return rows.map((r) => ({ id: r.id, client: cleanClient(r.client), createdAt: Number(r.created_at), lastUsedAt: r.last_used_at === null ? null : Number(r.last_used_at), expiresAt: Number(r.exp) }));
}

/** Disconnects one clipper of the person (Settings, or the extension's own Disconnect). */
export function revokeClipper(userId: string, id: string): boolean {
  tables();
  if (!/^[a-f0-9]{24}$/.test(id)) return false;
  const n = Number(sql("DELETE FROM clipper_tokens WHERE id = ? AND user_id = ?").run(id, userId).changes);
  if (n) audit(userId, "clipper-disconnect", id);
  return n > 0;
}

/** Every clipper of the account ("Sign out of all devices", account deletion). */
export function revokeAllClippers(userId: string): number {
  tables();
  return Number(sql("DELETE FROM clipper_tokens WHERE user_id = ?").run(userId).changes);
}

/** The Bearer token of a request, or null when it has none ("" when it has a malformed one). */
export function bearerOf(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? m[1] : "";
}
