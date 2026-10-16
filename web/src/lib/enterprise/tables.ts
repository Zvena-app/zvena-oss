// Server-only: the tables of zvena's Business / Enterprise features (Notion's
// Settings → Security, Identity, Audit log; Sites → Custom domain), created
// on first use. Each row belongs to a workspace and goes with it (ON DELETE
// CASCADE); secrets are stored as HMACs or sealed (lib/enterprise/seal.ts).

import { sql, store, storePath } from "../store";

const SCHEMA = `
-- Verified domains (Settings → Identity): a DNS TXT record proves the
-- workspace owns the domain; a domain is verified by one workspace at a time.
CREATE TABLE IF NOT EXISTS ent_domains (
  ws TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  token TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  checked_at INTEGER,
  -- "Allowed e-mail domains": people with a verified address here may join.
  allow_join INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ws, domain)
);
CREATE UNIQUE INDEX IF NOT EXISTS ent_domains_verified ON ent_domains(domain) WHERE verified_at IS NOT NULL;
-- The workspace's security settings (Settings → Security), as JSON.
CREATE TABLE IF NOT EXISTS ent_ws_settings (
  ws TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  json TEXT NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);
-- Single sign-on of a workspace: SAML 2.0 or OpenID Connect (the client secret sealed).
CREATE TABLE IF NOT EXISTS ent_sso (
  ws TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('saml', 'oidc')),
  json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  enforced INTEGER NOT NULL DEFAULT 0,
  jit INTEGER NOT NULL DEFAULT 1,
  jit_role TEXT NOT NULL DEFAULT 'editor' CHECK (jit_role IN ('editor', 'commenter', 'viewer')),
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);
-- One sign-in in flight (10 minutes): bound to the browser that started it
-- (bind: the HMAC of an HttpOnly cookie), with the SAML request id or the
-- OIDC PKCE verifier and nonce.
CREATE TABLE IF NOT EXISTS ent_sso_state (
  id TEXT PRIMARY KEY,
  ws TEXT NOT NULL,
  kind TEXT NOT NULL,
  bind TEXT NOT NULL,
  request_id TEXT,
  verifier TEXT,
  nonce TEXT,
  next TEXT,
  guest TEXT,
  consent TEXT,
  exp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ent_sso_state_exp ON ent_sso_state(exp);
-- SAML AuthnRequest ids we issued (InResponseTo), used once.
CREATE TABLE IF NOT EXISTS ent_saml_requests (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
-- Assertion / ID token ids already used (replay), kept until they expire.
CREATE TABLE IF NOT EXISTS ent_sso_replay (
  id TEXT PRIMARY KEY,
  exp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ent_sso_replay_exp ON ent_sso_replay(exp);
-- SCIM bearer tokens: only the HMAC is stored, the token is shown once.
CREATE TABLE IF NOT EXISTS ent_scim_tokens (
  id TEXT PRIMARY KEY,
  ws TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS ent_scim_tokens_ws ON ent_scim_tokens(ws);
-- People provisioned by SCIM (their membership is members; this keeps the
-- identity provider's view: externalId, userName, active, names).
CREATE TABLE IF NOT EXISTS ent_scim_users (
  ws TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_id TEXT,
  user_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  -- The account was created by SCIM (managed by this workspace's identity provider).
  created_account INTEGER NOT NULL DEFAULT 0,
  json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (ws, user_id)
);
CREATE INDEX IF NOT EXISTS ent_scim_users_name ON ent_scim_users(ws, user_name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS ent_scim_groups (
  group_id TEXT PRIMARY KEY REFERENCES ws_groups(id) ON DELETE CASCADE,
  ws TEXT NOT NULL,
  external_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Custom domains of published sites (Notion Sites → Custom domain): a
-- claim per workspace until one proves it (CNAME to its own target or TXT).
CREATE TABLE IF NOT EXISTS ent_site_domains (
  domain TEXT NOT NULL,
  ws TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  share_id TEXT NOT NULL,
  token TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  checked_at INTEGER,
  last_error TEXT,
  PRIMARY KEY (ws, domain)
);
CREATE UNIQUE INDEX IF NOT EXISTS ent_site_domains_verified ON ent_site_domains(domain) WHERE verified_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ent_site_domains_share ON ent_site_domains(share_id);
CREATE INDEX IF NOT EXISTS ent_site_domains_ws ON ent_site_domains(ws);
`;

let readyFor = "";

/** Creates the tables once per database file. */
export function ensureTables(): void {
  const path = storePath();
  if (readyFor === path) return;
  store().exec(SCHEMA);
  readyFor = path;
}

let lastSweep = 0;
/** Drops expired sign-ins in flight, request ids and replay entries (at most once a minute). */
export function sweepEnterprise(now = Date.now()): void {
  ensureTables();
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  sql("DELETE FROM ent_sso_state WHERE exp < ?").run(now);
  sql("DELETE FROM ent_saml_requests WHERE created_at < ?").run(now - 15 * 60_000);
  sql("DELETE FROM ent_sso_replay WHERE exp < ?").run(now);
}
