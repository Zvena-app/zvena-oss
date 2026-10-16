// zvena accounts and sessions.
//
// An account is an internal id. People sign in with a one-time e-mail link
// (src/lib/email-signin.ts) or their workspace's single sign-on
// (src/lib/enterprise/sso.ts); each method is a row in `identities`, and
// methods that share a verified e-mail meet in one account. On a test stand only, a test sign-in creates fake accounts.
// Sessions are random tokens in an HttpOnly cookie; the database keeps only
// their HMAC, so a leaked database cannot be replayed as cookies.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { ssoRequired } from "./enterprise/gate";
import { mailConfigured } from "./mail";
import { audit, sql, sweepExpired, tx } from "./store";

/** sso: a workspace's identity provider (lib/enterprise/sso.ts), subject "<workspace>:<its id>". */
export type Provider = "email" | "dev" | "sso";

export interface AuthUser {
  id: string;
  name: string;
  avatar?: string;
  email?: string;
  createdAt: number;
  isAdmin: boolean;
  /** Agreed to the current version of the consent (config.consentVersion). */
  consentOk: boolean;
}

const SESSION_TTL = 30 * 24 * 3600 * 1000;
const ROTATE_AFTER = 7 * 24 * 3600 * 1000;

function secret(): string {
  const s = process.env.AUTH_SECRET || "";
  if (s.length < 32) throw new Error("auth misconfigured: AUTH_SECRET (32+ chars) missing");
  return s;
}

function hasSecret(): boolean {
  return (process.env.AUTH_SECRET || "").length >= 32;
}

/** HMAC of a value under a purpose label (sessions, invites, OIDC codes…). */
export function mac(purpose: string, value: string): string {
  return createHmac("sha256", secret()).update(`${purpose}:${value}`).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// --- Users -------------------------------------------------------------------

interface UserRow {
  id: string;
  name: string;
  avatar: string | null;
  email: string | null;
  created_at: number;
  is_admin: number;
  blocked_at: number | null;
  consent_version: string | null;
}

function toUser(r: UserRow | undefined): AuthUser | null {
  if (!r || r.blocked_at) return null;
  return {
    id: r.id,
    name: r.name,
    ...(r.avatar ? { avatar: r.avatar } : {}),
    ...(r.email ? { email: r.email } : {}),
    createdAt: r.created_at,
    isAdmin: r.is_admin === 1 || adminIds().includes(r.id),
    consentOk: r.consent_version === config.consentVersion,
  };
}

/** Administrators by id (ZVENA_ADMIN_IDS, comma-separated) in addition to users.is_admin. */
function adminIds(): string[] {
  return (process.env.ZVENA_ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function getUser(id: string): AuthUser | null {
  return toUser(sql("SELECT id, name, avatar, email, created_at, is_admin, blocked_at, consent_version FROM users WHERE id = ?").get(id) as UserRow | undefined);
}

export interface ProviderProfile {
  provider: Provider;
  subject: string;
  name: string;
  /** Kept only when the provider vouches for it (emailVerified). */
  email?: string;
  emailVerified?: boolean;
}

/** A display name from an e-mail's local part: "anna.smith" → "Anna Smith". */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const words = local.split(/[._+-]+/).filter((w) => w && !/^\d+$/.test(w));
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ").slice(0, 60);
}

export type SignInResult =
  | { ok: true; user: AuthUser; isNew: boolean }
  | { ok: false; error: "consent-required" | "blocked" | "sso-required" };

/**
 * Signs in the person behind a provider identity. Every sign-in button sits
 * next to the "By continuing, you agree to the Terms…" line, so the callers
 * pass the Terms version shown there; without one (an old link) a new
 * person is not registered and a returning person with an outdated version
 * is asked again. An unknown identity whose verified e-mail belongs to an
 * account joins that account (the e-mail link and single sign-on both prove
 * the address), so one person keeps one account whichever button they use.
 */
export function signInWith(p: ProviderProfile, consentVersion: string | null): SignInResult {
  const email = p.emailVerified && p.email && /^[^\s@]+@[^\s@]+$/.test(p.email) ? p.email.trim().toLowerCase().slice(0, 254) : null;
  const name = p.name.trim().slice(0, 120) || (email ? nameFromEmail(email) : "") || "zvena user";
  return tx(() => {
    const known = sql("SELECT user_id FROM identities WHERE provider = ? AND subject = ?").get(p.provider, p.subject) as { user_id: string } | undefined;
    let userId = known?.user_id ?? null;
    let linked = false;
    if (!userId && email) {
      const byEmail = sql("SELECT id FROM users WHERE email = ? COLLATE NOCASE ORDER BY created_at LIMIT 1").get(email) as { id: string } | undefined;
      if (byEmail) {
        userId = byEmail.id;
        linked = true;
      }
    }
    // A workspace that enforces SSO for the address lets it in only that way (lib/enterprise/gate.ts).
    if (ssoRequired(p.provider, userId, [email])) return { ok: false as const, error: "sso-required" as const };
    if (userId) {
      const row = sql("SELECT blocked_at, consent_version FROM users WHERE id = ?").get(userId) as { blocked_at: number | null; consent_version: string | null } | undefined;
      if (!row || row.blocked_at) return { ok: false as const, error: "blocked" as const };
      // The Terms changed since the last agreement: ask again.
      if (!consentVersion && row.consent_version !== config.consentVersion) return { ok: false as const, error: "consent-required" as const };
      if (linked) {
        sql("INSERT INTO identities (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)").run(p.provider, p.subject, userId, Date.now());
        audit(userId, "identity-linked", p.provider);
      }
      // A verified e-mail fills a missing one; a name the person set stays.
      sql("UPDATE users SET email = COALESCE(email, ?), last_seen_at = ? WHERE id = ?").run(email, Date.now(), userId);
      if (consentVersion) sql("UPDATE users SET consent_version = ?, consent_at = ? WHERE id = ?").run(consentVersion, Date.now(), userId);
      const user = getUser(userId);
      if (!user) return { ok: false as const, error: "blocked" as const };
      audit(user.id, "signin", p.provider);
      return { ok: true as const, user, isNew: false };
    }
    if (!consentVersion) return { ok: false as const, error: "consent-required" as const };
    // Hex: the id also names the Design profile (an e-mail-shaped login that Penpot lower-cases).
    const id = randomBytes(12).toString("hex");
    const now = Date.now();
    sql("INSERT INTO users (id, name, avatar, email, created_at, last_seen_at, consent_version, consent_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)").run(id, name, email, now, now, consentVersion, now);
    sql("INSERT INTO identities (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)").run(p.provider, p.subject, id, now);
    audit(id, "signup", p.provider);
    return { ok: true as const, user: getUser(id) as AuthUser, isNew: true };
  });
}

/** Sign-in methods of an account (for Settings). */
export function identitiesOf(userId: string): { provider: Provider; createdAt: number }[] {
  return (sql("SELECT provider, created_at FROM identities WHERE user_id = ? ORDER BY created_at").all(userId) as { provider: Provider; created_at: number }[]).map((r) => ({
    provider: r.provider,
    createdAt: r.created_at,
  }));
}

export function renameUser(userId: string, name: string): void {
  const n = name.trim().slice(0, 120);
  if (n) sql("UPDATE users SET name = ? WHERE id = ?").run(n, userId);
}

// --- Sessions ----------------------------------------------------------------

/** Cookie name: __Host- (Secure, whole host, no Domain) over HTTPS; plain in local dev. */
export function sessionCookieName(): string {
  return cookieSecure() ? "__Host-zv_s" : "zv_s";
}

export function cookieSecure(): boolean {
  return !config.appUrl.startsWith("http://");
}

export function issueSession(userId: string): string {
  const token = randomBytes(32).toString("base64url");
  sweepExpired();
  sql("INSERT INTO sessions (sid, user_id, exp, iat) VALUES (?, ?, ?, ?)").run(mac("sid", token), userId, Date.now() + SESSION_TTL, Date.now());
  return token;
}

function cookieValue(cookieHeader: string | null, name: string): string | null {
  for (const part of (cookieHeader ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function readCookie(req: Request, name: string): string | null {
  return cookieValue(req.headers.get("cookie"), name);
}

function sessionRow(cookieHeader: string | null): { sid: string; user_id: string; exp: number; iat: number } | null {
  if (!cookieHeader || !hasSecret()) return null;
  const token = cookieValue(cookieHeader, sessionCookieName());
  if (!token || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
  const row = sql("SELECT sid, user_id, exp, iat FROM sessions WHERE sid = ?").get(mac("sid", token)) as { sid: string; user_id: string; exp: number; iat: number } | undefined;
  return row && row.exp > Date.now() ? row : null;
}

export function readSession(cookieHeader: string | null): AuthUser | null {
  const row = sessionRow(cookieHeader);
  return row ? getUser(row.user_id) : null;
}

export function sessionUser(req: Request): AuthUser | null {
  return readSession(req.headers.get("cookie"));
}

export function sessionCookie(token: string, maxAgeSec = SESSION_TTL / 1000): string {
  const secure = cookieSecure() ? "; Secure" : "";
  return `${sessionCookieName()}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${maxAgeSec}`;
}

export function clearSessionCookie(): string {
  const secure = cookieSecure() ? "; Secure" : "";
  return `${sessionCookieName()}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`;
}

export function destroySession(cookieHeader: string | null): void {
  const row = sessionRow(cookieHeader);
  if (row) sql("DELETE FROM sessions WHERE sid = ?").run(row.sid);
}

/** Ends every session of the account (all devices). */
export function destroyAllSessions(userId: string): number {
  return Number(sql("DELETE FROM sessions WHERE user_id = ?").run(userId).changes);
}

/**
 * Validates the cookie and, once the session is a week old, swaps it for a
 * fresh token (bounds the use of a stolen cookie). The old token keeps
 * working for a minute so parallel tabs are not signed out.
 */
export function refreshSession(cookieHeader: string | null): { user: AuthUser; setCookie?: string } | null {
  const row = sessionRow(cookieHeader);
  if (!row) return null;
  const user = getUser(row.user_id);
  if (!user) return null;
  sql("UPDATE users SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?").run(Date.now(), user.id, Date.now() - 3600_000);
  if (row.iat + ROTATE_AFTER > Date.now()) return { user };
  const token = randomBytes(32).toString("base64url");
  tx(() => {
    sql("INSERT INTO sessions (sid, user_id, exp, iat) VALUES (?, ?, ?, ?)").run(mac("sid", token), user.id, Date.now() + SESSION_TTL, Date.now());
    sql("UPDATE sessions SET exp = MIN(exp, ?) WHERE sid = ?").run(Date.now() + 60_000, row.sid);
  });
  return { user, setCookie: sessionCookie(token) };
}

/** Which sign-in methods to offer (a method without keys stays hidden). */
export function authStatus(): { email: boolean; dev: boolean } {
  return {
    // The link needs a way to send letters (SMTP), or the stand's outbox.
    email: mailConfigured() || (config.isTestStand && Boolean(process.env.ZVENA_MAIL_OUTBOX)),
    dev: config.devLogin,
  };
}

/** Records the agreement to the current Terms version (the /consent page). */
export function recordConsent(userId: string): void {
  sql("UPDATE users SET consent_version = ?, consent_at = ? WHERE id = ?").run(config.consentVersion, Date.now(), userId);
  audit(userId, "consent", config.consentVersion);
}
