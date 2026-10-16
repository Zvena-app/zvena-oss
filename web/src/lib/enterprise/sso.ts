// Server-only: a workspace's single sign-on (Notion's Settings → Identity →
// SAML SSO), with SAML 2.0 (saml.ts) or OpenID Connect (oidc.ts):
//
//   enabled    people at the workspace's verified domains may sign in
//              through the identity provider ("Continue with SSO")
//   enforced   …and only that way (gate.ts); owners keep a break-glass way in
//   jit        someone who signs in through SSO and is not a member yet
//              joins with `jitRole` (just-in-time provisioning); without it
//              only existing members (or SCIM's) may sign in
//
// A sign-in in flight is a row bound to the browser that started it (an
// HttpOnly cookie whose HMAC the row keeps); the identity provider's answer
// must come back to the same browser and the same workspace. The address
// the provider asserts must be at one of the workspace's verified domains:
// a workspace's provider can never sign anyone in under another domain.

import { randomBytes } from "node:crypto";
import { cookieSecure, getUser, mac, safeEqual, signInWith, type AuthUser } from "../auth";
import { config } from "../config";
import { safeNext } from "../safe-next";
import { audit, sql, tx } from "../store";
import { LimitError, roleIn, type Role } from "../workspaces";
import { isWorkspaceEmail, workspaceOfEmailDomain, emailDomain } from "./domains";
import { cleanOidcSettings, oidcCallback, oidcRequest, type OidcSettings } from "./oidc";
import { cleanSamlSettings, samlRequest, validateSamlResponse, type SamlSettings } from "./saml";
import { ensureTables, sweepEnterprise } from "./tables";

export type SsoKind = "saml" | "oidc";
export type JitRole = Exclude<Role, "owner">;
export const JIT_ROLES: readonly JitRole[] = ["editor", "commenter", "viewer"];

export interface SsoConfig {
  kind: SsoKind;
  enabled: boolean;
  enforced: boolean;
  jit: boolean;
  jitRole: JitRole;
  saml?: SamlSettings;
  oidc?: OidcSettings;
  updatedAt: number;
}

export const SSO_COOKIE = "zv_sso";
const STATE_TTL = 10 * 60_000;
const WS_RE = /^[A-Za-z0-9_-]{8,40}$/;

export class SsoError extends Error {}

interface Row {
  kind: SsoKind;
  json: string;
  enabled: number;
  enforced: number;
  jit: number;
  jit_role: JitRole;
  updated_at: number;
}

export function ssoOf(ws: string): SsoConfig | null {
  if (!WS_RE.test(ws)) return null;
  ensureTables();
  const r = sql("SELECT kind, json, enabled, enforced, jit, jit_role, updated_at FROM ent_sso WHERE ws = ?").get(ws) as Row | undefined;
  if (!r) return null;
  let settings: unknown;
  try {
    settings = JSON.parse(r.json);
  } catch {
    return null;
  }
  return {
    kind: r.kind,
    enabled: r.enabled === 1,
    enforced: r.enforced === 1,
    jit: r.jit === 1,
    jitRole: r.jit_role,
    ...(r.kind === "saml" ? { saml: settings as SamlSettings } : { oidc: settings as OidcSettings }),
    updatedAt: r.updated_at,
  };
}

/**
 * Saves the owner's SSO settings (throws SamlConfigError / OidcConfigError
 * / SsoError). Enforcing needs SSO on and a verified domain.
 */
export function saveSso(ws: string, actor: string, body: unknown): SsoConfig {
  ensureTables();
  const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const prev = ssoOf(ws);
  const kind: SsoKind = b.kind === "oidc" ? "oidc" : b.kind === "saml" ? "saml" : (prev?.kind ?? "saml");
  // Unchanged identity-provider fields may be left out (toggling a switch).
  const hasProvider = typeof b.provider === "object" && b.provider !== null;
  let settings: SamlSettings | OidcSettings;
  if (!hasProvider && prev && prev.kind === kind) settings = (kind === "saml" ? prev.saml : prev.oidc) as SamlSettings | OidcSettings;
  else if (kind === "saml") settings = cleanSamlSettings(b.provider);
  else settings = cleanOidcSettings(ws, b.provider, prev?.kind === "oidc" ? (prev.oidc ?? null) : null);
  // The IdP-initiated switch alone, without sending the provider again.
  if (kind === "saml" && typeof b.allowIdpInitiated === "boolean") settings = { ...(settings as SamlSettings), allowIdpInitiated: b.allowIdpInitiated };
  const enabled = typeof b.enabled === "boolean" ? b.enabled : (prev?.enabled ?? false);
  const enforced = enabled && (typeof b.enforced === "boolean" ? b.enforced : (prev?.enforced ?? false));
  if (enforced && !sql("SELECT 1 FROM ent_domains WHERE ws = ? AND verified_at IS NOT NULL").get(ws)) throw new SsoError("verify a domain first");
  const jit = typeof b.jit === "boolean" ? b.jit : (prev?.jit ?? true);
  const jitRole = (JIT_ROLES as readonly unknown[]).includes(b.jitRole) ? (b.jitRole as JitRole) : (prev?.jitRole ?? "editor");
  const now = Date.now();
  sql(
    `INSERT INTO ent_sso (ws, kind, json, enabled, enforced, jit, jit_role, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ws) DO UPDATE SET kind = excluded.kind, json = excluded.json, enabled = excluded.enabled, enforced = excluded.enforced, jit = excluded.jit, jit_role = excluded.jit_role, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).run(ws, kind, JSON.stringify(settings), enabled ? 1 : 0, enforced ? 1 : 0, jit ? 1 : 0, jitRole, actor, now);
  const meta: Record<string, unknown> = { kind, enabled, enforced, jit, jitRole, ...(kind === "saml" ? { idpInitiated: (settings as SamlSettings).allowIdpInitiated } : {}) };
  if (hasProvider || !prev || prev.kind !== kind) meta.provider = "changed";
  audit(actor, "sso.update", ws, meta);
  if (prev?.enforced !== enforced) audit(actor, enforced ? "sso.enforce.on" : "sso.enforce.off", ws);
  // SSO required from now on: the members it covers sign in again, through it (their other sessions end;
  // owners keep theirs — the break-glass way in).
  if (enforced && !prev?.enforced) {
    const domains = (sql("SELECT domain FROM ent_domains WHERE ws = ? AND verified_at IS NOT NULL").all(ws) as { domain: string }[]).map((d) => d.domain);
    const covered = (sql("SELECT u.id, u.email FROM members m JOIN users u ON u.id = m.user_id WHERE m.ws_id = ? AND m.role <> 'owner' AND u.email IS NOT NULL").all(ws) as { id: string; email: string }[]).filter((u) =>
      domains.includes(emailDomain(u.email))
    );
    let ended = 0;
    for (const u of covered) ended += Number(sql("DELETE FROM sessions WHERE user_id = ?").run(u.id).changes);
    if (covered.length) audit(actor, "sso.sessions.ended", ws, { people: covered.length, sessions: ended });
  }
  return ssoOf(ws) as SsoConfig;
}

export function deleteSso(ws: string, actor: string): boolean {
  ensureTables();
  const ok = Number(sql("DELETE FROM ent_sso WHERE ws = ?").run(ws).changes) > 0;
  if (ok) audit(actor, "sso.delete", ws);
  return ok;
}

/** The workspace whose SSO an address signs in with (its verified domain, SSO on). */
export function ssoWorkspaceForEmail(email: string | null | undefined): string | null {
  const ws = workspaceOfEmailDomain(email);
  return ws && ssoOf(ws)?.enabled ? ws : null;
}

// --- Starting a sign-in ----------------------------------------------------------------

export interface Started {
  /** Where to send the browser (or a self-posting form for SAML's POST binding). */
  location?: string;
  html?: string;
  cookie: string;
}

function bindCookie(value: string, maxAge: number): string {
  return `${SSO_COOKIE}=${value}; Path=/api/sso; HttpOnly; SameSite=Lax${cookieSecure() ? "; Secure" : ""}; Max-Age=${maxAge}`;
}

export const clearBindCookie = () => bindCookie("", 0);

export async function startSso(ws: string, opts: { next: string; guest: string | null; consent: string | null }): Promise<Started> {
  const c = ssoOf(ws);
  if (!c || !c.enabled) throw new SsoError("sso off");
  sweepEnterprise();
  const id = randomBytes(24).toString("base64url");
  const bind = randomBytes(32).toString("base64url");
  const row = { id, ws, kind: c.kind, bind: mac("sso-bind", bind), next: safeNext(opts.next), guest: opts.guest, consent: opts.consent, exp: Date.now() + STATE_TTL };
  let out: Omit<Started, "cookie">;
  let requestId: string | null = null;
  let verifier: string | null = null;
  let nonce: string | null = null;
  if (c.kind === "saml" && c.saml) {
    const r = await samlRequest(ws, c.saml, id);
    requestId = r.requestId;
    out = r.form ? { html: r.form } : { location: r.url };
  } else if (c.kind === "oidc" && c.oidc) {
    const r = await oidcRequest(ws, c.oidc, id);
    verifier = r.verifier;
    nonce = r.nonce;
    out = { location: r.url };
  } else throw new SsoError("misconfigured");
  sql("INSERT INTO ent_sso_state (id, ws, kind, bind, request_id, verifier, nonce, next, guest, consent, exp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    row.id,
    row.ws,
    row.kind,
    row.bind,
    requestId,
    verifier,
    nonce,
    row.next,
    row.guest,
    row.consent,
    row.exp
  );
  return { ...out, cookie: bindCookie(bind, STATE_TTL / 1000) };
}

interface StateRow {
  id: string;
  ws: string;
  kind: SsoKind;
  bind: string;
  request_id: string | null;
  verifier: string | null;
  nonce: string | null;
  next: string | null;
  guest: string | null;
  consent: string | null;
  exp: number;
}

/** The sign-in in flight `id` of this workspace, for the browser holding `bind` (used once). */
function takeState(ws: string, id: string | null, bind: string | null): StateRow | null {
  if (!id || !/^[A-Za-z0-9_-]{20,64}$/.test(id)) return null;
  ensureTables();
  const row = sql("SELECT id, ws, kind, bind, request_id, verifier, nonce, next, guest, consent, exp FROM ent_sso_state WHERE id = ?").get(id) as StateRow | undefined;
  if (!row) return null;
  if (row.ws !== ws || row.exp < Date.now() || !bind || !safeEqual(mac("sso-bind", bind), row.bind)) return null;
  sql("DELETE FROM ent_sso_state WHERE id = ?").run(id);
  return row;
}

/** Whether a sign-in in flight exists under that id (a RelayState that is ours, whoever holds it). */
export function knownState(id: string | null): boolean {
  if (!id || !/^[A-Za-z0-9_-]{20,64}$/.test(id)) return false;
  ensureTables();
  return Boolean(sql("SELECT 1 FROM ent_sso_state WHERE id = ?").get(id));
}

// --- Finishing it ----------------------------------------------------------------------

export type SsoResult =
  | { ok: true; user: AuthUser; isNew: boolean; ws: string; next: string; guest: string | null }
  | { ok: false; error: "sso-failed" | "sso-domain" | "sso-not-member" | "sso-limit" | "state" | "consent-required" | "blocked"; next: string };

/** The account for an identity the provider vouched for: sign-in, JIT membership, audit. */
function admit(ws: string, c: SsoConfig, subject: string, email: string | null, name: string, consent: string | null, next: string): SsoResult {
  // The provider speaks for the workspace's own domains only.
  if (!email || !isWorkspaceEmail(ws, email)) {
    audit(null, "sso.reject", ws, { reason: "domain" });
    return { ok: false, error: "sso-domain", next };
  }
  const known =
    (sql("SELECT user_id FROM identities WHERE provider = 'sso' AND subject = ?").get(subject) as { user_id: string } | undefined)?.user_id ??
    (sql("SELECT id FROM users WHERE email = ? COLLATE NOCASE ORDER BY created_at LIMIT 1").get(email) as { id: string } | undefined)?.id ??
    null;
  const member = known ? roleIn(known, ws) : null;
  if (!member && !c.jit) {
    audit(known, "sso.reject", ws, { reason: "not a member" });
    return { ok: false, error: "sso-not-member", next };
  }
  const r = signInWith({ provider: "sso", subject, name, email, emailVerified: true }, consent);
  if (!r.ok) return { ok: false, error: r.error === "blocked" ? "blocked" : r.error === "consent-required" ? "consent-required" : "sso-failed", next };
  try {
    tx(() => {
      if (roleIn(r.user.id, ws)) return;
      if (config.maxMembers > 0) {
        const n = sql("SELECT COUNT(*) AS n FROM members WHERE ws_id = ?").get(ws) as { n: number };
        if (Number(n.n) >= config.maxMembers) throw new LimitError("members");
      }
      sql("INSERT INTO members (ws_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").run(ws, r.user.id, c.jitRole, Date.now());
      audit(r.user.id, "sso.jit", ws, { role: c.jitRole });
    });
  } catch (e) {
    if (e instanceof LimitError) return { ok: false, error: "sso-limit", next };
    throw e;
  }
  audit(r.user.id, "sso.signin", ws, { kind: c.kind });
  return { ok: true, user: getUser(r.user.id) as AuthUser, isNew: r.isNew, ws, next, guest: null };
}

/**
 * A SAMLResponse posted to the workspace's ACS. `relayState` names the
 * sign-in this browser started (`bind`: its cookie); without one, the
 * response is unsolicited and needs the owner's "IdP-initiated" switch.
 */
export async function finishSaml(ws: string, samlResponse: string, relayState: string | null, bind: string | null): Promise<SsoResult> {
  const c = ssoOf(ws);
  if (!c?.enabled || c.kind !== "saml" || !c.saml) return { ok: false, error: "sso-failed", next: "/home" };
  sweepEnterprise();
  const st = takeState(ws, relayState, bind);
  // A RelayState of ours from another browser (or after its time) is a stolen or stale response.
  if (!st && knownState(relayState)) return { ok: false, error: "state", next: "/home" };
  if (st && st.kind !== "saml") return { ok: false, error: "state", next: "/home" };
  let who;
  try {
    who = await validateSamlResponse(ws, c.saml, samlResponse, st?.request_id ?? null);
  } catch (e) {
    audit(null, "sso.reject", ws, { kind: "saml", reason: e instanceof Error ? e.message.slice(0, 80) : "invalid" });
    return { ok: false, error: "sso-failed", next: st ? safeNext(st.next) : "/home" };
  }
  const subject = `${ws}:${who.nameId}`;
  const r = admit(ws, c, subject, who.email, who.name, st?.consent ?? null, st ? safeNext(st.next) : "/home");
  return r.ok ? { ...r, guest: st?.guest ?? null } : r;
}

/** The OIDC provider's redirect back (code + state). */
export async function finishOidc(ws: string, params: URLSearchParams, bind: string | null): Promise<SsoResult> {
  const c = ssoOf(ws);
  if (!c?.enabled || c.kind !== "oidc" || !c.oidc) return { ok: false, error: "sso-failed", next: "/home" };
  sweepEnterprise();
  const st = takeState(ws, params.get("state"), bind);
  if (!st || st.kind !== "oidc" || !st.verifier || !st.nonce) return { ok: false, error: "state", next: "/home" };
  const next = safeNext(st.next);
  if (params.get("error")) return { ok: false, error: "sso-failed", next };
  let who;
  try {
    who = await oidcCallback(ws, c.oidc, params, { verifier: st.verifier, nonce: st.nonce, state: st.id });
  } catch (e) {
    audit(null, "sso.reject", ws, { kind: "oidc", reason: e instanceof Error ? e.message.slice(0, 80) : "invalid" });
    return { ok: false, error: "sso-failed", next };
  }
  // One ID token, one sign-in.
  try {
    sql("INSERT INTO ent_sso_replay (id, exp) VALUES (?, ?)").run(`oidc:${mac("sso-replay", `${ws}\n${who.tokenId}`)}`, Math.max(who.exp, Date.now()) + 60_000);
  } catch {
    return { ok: false, error: "sso-failed", next };
  }
  const r = admit(ws, c, `${ws}:${who.sub}`, who.email, who.name, st.consent, next);
  return r.ok ? { ...r, guest: st.guest } : r;
}
