// Server-only persistent store of zvena (SQLite via Node's built-in node:sqlite).
//
// Accounts are keyed by an internal id (users.id): a person signs in with
// Google, GitHub or a one-time e-mail link, and those sign-in methods live in
// `identities` (one account may have several, linked by a verified e-mail).
// Documents belong to a workspace, not to a person; members have roles.
// WAL mode: readers never block the single writer; one process owns the file.

import type { DatabaseSync as DatabaseSyncT, StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrateProjects } from "./projects/schema";
import { renameLegacyValues } from "./legacy-migrate";

// getBuiltinModule keeps the bundler away from a builtin it may not know.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

/** Where the database lives (tests and isolated servers set their own). */
export function storePath(): string {
  return process.env.ZVENA_DB_PATH || "/var/lib/zvena/zvena.db";
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT,
  -- Verified e-mail from a sign-in method (NULL when none was verified, e.g. a GitHub account without one).
  email TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  -- The Terms / Privacy Policy version accepted at sign-up or later (version + time).
  consent_version TEXT,
  consent_at INTEGER,
  is_admin INTEGER NOT NULL DEFAULT 0,
  blocked_at INTEGER
);
CREATE TABLE IF NOT EXISTS identities (
  provider TEXT NOT NULL,          -- google | github | email | dev
  subject TEXT NOT NULL,           -- the provider's stable user id (email: the lower-cased address)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS identities_user ON identities(user_id);
CREATE INDEX IF NOT EXISTS users_email ON users(email COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,            -- HMAC of the cookie token, never the token itself
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exp INTEGER NOT NULL,
  iat INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS oauth_state (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  verifier TEXT NOT NULL,          -- PKCE code verifier
  consent TEXT,                    -- Terms version shown next to the button the person pressed
  next TEXT,                       -- where to return (same-origin path)
  guest TEXT,                      -- guest id whose files move into the account
  exp INTEGER NOT NULL
);
-- One-time e-mail sign-in: a link token and a 6-digit code, both stored as
-- HMACs only; a row is deleted when used, after too many wrong codes, or on expiry.
CREATE TABLE IF NOT EXISTS email_signin (
  id TEXT PRIMARY KEY,             -- HMAC of the link token
  ref TEXT NOT NULL UNIQUE,        -- opaque handle of the "check your inbox" page (never the address)
  email TEXT NOT NULL,             -- lower-cased address the letter went to
  code TEXT NOT NULL,              -- HMAC of the 6-digit code (bound to the row)
  next TEXT,
  guest TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  exp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS email_signin_email ON email_signin(email, created_at);
CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  personal INTEGER NOT NULL DEFAULT 0,
  -- The Penpot team that holds this workspace's designs (NULL until Design is first opened).
  penpot_team_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS workspaces_owner ON workspaces(owner_id);
CREATE TABLE IF NOT EXISTS members (
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'commenter', 'viewer')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (ws_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON members(user_id);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,             -- HMAC of the link token
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('editor', 'commenter', 'viewer')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  max_uses INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS invites_ws ON invites(ws_id);
-- Documents: one row per page / database / database row of a workspace,
-- synced like before (server stamp cursor, last write wins, tombstones).
CREATE TABLE IF NOT EXISTS notes (
  ws TEXT NOT NULL,
  id TEXT NOT NULL,
  stamp INTEGER NOT NULL,
  client_at INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  json TEXT,
  updated_by TEXT,
  PRIMARY KEY (ws, id)
);
CREATE INDEX IF NOT EXISTS notes_sync ON notes(ws, stamp);
CREATE TABLE IF NOT EXISTS note_shares (
  id TEXT PRIMARY KEY,
  ws TEXT NOT NULL,
  note_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  title TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  -- Taken down by a moderator after a complaint (the link then says so).
  removed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS note_shares_ws_note ON note_shares(ws, note_id);
CREATE TABLE IF NOT EXISTS note_forms (
  id TEXT PRIMARY KEY,
  ws TEXT NOT NULL,
  db_id TEXT NOT NULL,
  view_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  responses INTEGER NOT NULL DEFAULT 0,
  removed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS note_forms_ws_view ON note_forms(ws, db_id, view_id);
-- Page history (lib/notes/versions.ts): a version is one person's editing
-- session (started → at), stored gzip'd; kind 'delete' is the last state
-- before a delete forever. Events are moves, trash and restores (Updates).
CREATE TABLE IF NOT EXISTS note_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ws TEXT NOT NULL,
  note_id TEXT NOT NULL,
  started INTEGER NOT NULL,
  at INTEGER NOT NULL,
  by TEXT,
  kind TEXT NOT NULL DEFAULT 'edit',
  title TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL,
  data BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS note_versions_note ON note_versions(ws, note_id, at);
CREATE INDEX IF NOT EXISTS note_versions_ws ON note_versions(ws, at);
CREATE TABLE IF NOT EXISTS note_events (
  ws TEXT NOT NULL,
  note_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  by TEXT,
  kind TEXT NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS note_events_note ON note_events(ws, note_id, at);
-- Page analytics: a member's open of a page (at most one per 30 minutes).
CREATE TABLE IF NOT EXISTS note_views (
  ws TEXT NOT NULL,
  note_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS note_views_note ON note_views(ws, note_id, at);
CREATE INDEX IF NOT EXISTS note_views_user ON note_views(user_id);
-- Who stored which uploaded file (files are content-addressed and stored once;
-- each owner pays for its own copy in the storage quota).
CREATE TABLE IF NOT EXISTS files (
  name TEXT NOT NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('user', 'guest')),
  owner_id TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (name, owner_kind, owner_id)
);
CREATE INDEX IF NOT EXISTS files_owner ON files(owner_kind, owner_id);
-- Guests (no account): a random id in a cookie; their uploads are removed
-- after a period of inactivity (the app warns them first).
CREATE TABLE IF NOT EXISTS guests (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  warned_at INTEGER
);
-- Guest uploads (no account) per day, for the server-wide daily cap: bytes
-- and time only, no owner or address.
CREATE TABLE IF NOT EXISTS guest_uploads (
  at INTEGER NOT NULL,
  bytes INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS guest_uploads_at ON guest_uploads(at);
-- Uploaded files a moderator took down (by content hash): never served or stored again.
CREATE TABLE IF NOT EXISTS removed_files (
  hash TEXT PRIMARY KEY,
  removed_at INTEGER NOT NULL,
  removed_by TEXT
);
-- Reports about public pages, forms, designs and uploaded files (the "Report" button).
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('page', 'form', 'design', 'file')),
  target TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  reporter_id TEXT,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'removed', 'rejected')),
  resolved_by TEXT,
  resolved_at INTEGER,
  resolution TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS reports_status ON reports(status, created_at);
-- Who has a document open for editing right now (heartbeats): shown to
-- others and used for the configurable editors-per-document limit.
CREATE TABLE IF NOT EXISTS presence (
  ws TEXT NOT NULL,
  note_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (ws, note_id, user_id)
);
-- Favorites are each person's own (Notion): the star never travels with the shared page.
CREATE TABLE IF NOT EXISTS note_favorites (
  ws TEXT NOT NULL,
  user_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (ws, user_id, note_id)
);
-- Reminders reach the Inbox of whoever set them, at their time (no tab needs to be open).
CREATE TABLE IF NOT EXISTS note_reminders (
  ws TEXT NOT NULL,
  rkey TEXT NOT NULL,
  note_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  sent_at INTEGER,
  PRIMARY KEY (ws, rkey, user_id)
);
CREATE INDEX IF NOT EXISTS note_reminders_due ON note_reminders(sent_at, at);
-- Each person's time zone (their browser reports it): reminders fire at their 9:00.
CREATE TABLE IF NOT EXISTS user_tz (
  user_id TEXT PRIMARY KEY,
  tz TEXT NOT NULL,
  at INTEGER NOT NULL
);
-- Co-editing: the Yjs state of a page edited together (lib/notes/collab.ts);
-- its JSON snapshot stays in notes.json.
CREATE TABLE IF NOT EXISTS note_ydocs (
  ws TEXT NOT NULL,
  note_id TEXT NOT NULL,
  state BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (ws, note_id)
);
CREATE TABLE IF NOT EXISTS oidc_codes (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  nonce TEXT,
  exp INTEGER NOT NULL,
  locale TEXT
);
-- Security journal: sign-ins, role changes, exports, deletions. Holds ids,
-- never names, e-mails, IPs or document content.
CREATE TABLE IF NOT EXISTS audit (
  at INTEGER NOT NULL,
  actor TEXT,
  action TEXT NOT NULL,
  target TEXT,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
-- Address lookups for the Map view and the Place property (lib/maps.ts):
-- the geocoder's answers by query, kept 30 days (no user ids).
CREATE TABLE IF NOT EXISTS geo_cache (
  key TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  at INTEGER NOT NULL
);
-- A workspace's custom emoji (Notion's :name:): an uploaded image under a name.
CREATE TABLE IF NOT EXISTS custom_emoji (
  ws TEXT NOT NULL,
  name TEXT NOT NULL,
  file TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (ws, name)
);
-- Documents access (lib/notes/access.ts), as in Notion. Teamspaces group a
-- workspace's top-level pages; a page may be restricted to the people
-- invited to it; grants give one person a level on a page and its subtree
-- (members and guests, i.e. people outside the workspace).
CREATE TABLE IF NOT EXISTS teamspaces (
  id TEXT PRIMARY KEY,
  ws TEXT NOT NULL,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  -- open: every member sees it; closed: listed, pages for its members only; private: members only.
  privacy TEXT NOT NULL CHECK (privacy IN ('open', 'closed', 'private')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS teamspaces_ws ON teamspaces(ws);
CREATE TABLE IF NOT EXISTS teamspace_members (
  ts_id TEXT NOT NULL REFERENCES teamspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (ts_id, user_id)
);
CREATE INDEX IF NOT EXISTS teamspace_members_user ON teamspace_members(user_id);
-- A page whose general access is "only people invited" (absent: as its parent).
CREATE TABLE IF NOT EXISTS note_access (
  ws TEXT NOT NULL,
  note_id TEXT NOT NULL,
  restricted INTEGER NOT NULL DEFAULT 1,
  changed_by TEXT,
  changed_at INTEGER NOT NULL,
  PRIMARY KEY (ws, note_id)
);
CREATE TABLE IF NOT EXISTS note_grants (
  ws TEXT NOT NULL,
  note_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('full', 'edit', 'comment', 'view')),
  granted_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (ws, note_id, user_id)
);
CREATE INDEX IF NOT EXISTS note_grants_user ON note_grants(user_id, ws);
-- Notes a person can no longer read since an access change: their devices drop them.
CREATE TABLE IF NOT EXISTS note_revoked (
  ws TEXT NOT NULL,
  note_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  stamp INTEGER NOT NULL,
  PRIMARY KEY (ws, note_id, user_id)
);
CREATE INDEX IF NOT EXISTS note_revoked_user ON note_revoked(ws, user_id, stamp);
-- Page invite links (guests): only the HMAC of the token is stored.
CREATE TABLE IF NOT EXISTS page_invites (
  id TEXT PRIMARY KEY,
  ws TEXT NOT NULL,
  note_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('edit', 'comment', 'view')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  max_uses INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS page_invites_note ON page_invites(ws, note_id);
-- Groups of a workspace's members (Notion: Settings → Members → Groups):
-- pages and teamspaces can be shared with a group as a whole.
CREATE TABLE IF NOT EXISTS ws_groups (
  id TEXT PRIMARY KEY,
  ws TEXT NOT NULL,
  name TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ws_groups_ws ON ws_groups(ws);
CREATE TABLE IF NOT EXISTS ws_group_members (
  group_id TEXT NOT NULL REFERENCES ws_groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS ws_group_members_user ON ws_group_members(user_id);
CREATE TABLE IF NOT EXISTS note_group_grants (
  ws TEXT NOT NULL,
  note_id TEXT NOT NULL,
  group_id TEXT NOT NULL REFERENCES ws_groups(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('full', 'edit', 'comment', 'view')),
  granted_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (ws, note_id, group_id)
);
CREATE INDEX IF NOT EXISTS note_group_grants_group ON note_group_grants(group_id);
CREATE TABLE IF NOT EXISTS teamspace_groups (
  ts_id TEXT NOT NULL REFERENCES teamspaces(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES ws_groups(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (ts_id, group_id)
);
-- "Request access" to a page someone cannot open (Notion): people with full access approve.
CREATE TABLE IF NOT EXISTS note_access_requests (
  ws TEXT NOT NULL,
  note_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (ws, note_id, user_id)
);
-- Wiki verification: owners were told it expires soon / has expired (once per verification).
CREATE TABLE IF NOT EXISTS note_verify_notices (
  ws TEXT NOT NULL,
  note_id TEXT NOT NULL,
  prop_id TEXT NOT NULL,
  until TEXT NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (ws, note_id, prop_id, until, kind)
);
`;

/**
 * Columns added after a database was created (CREATE TABLE IF NOT EXISTS
 * leaves existing tables alone): notes.parent_id and notes.space, read by
 * the access checks without parsing every note, backfilled once; and
 * oidc_codes.locale.
 */
function migrate(d: DatabaseSyncT): void {
  const cols = new Set((d.prepare("PRAGMA table_info(notes)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("parent_id")) {
    d.exec("ALTER TABLE notes ADD COLUMN parent_id TEXT");
    d.exec("ALTER TABLE notes ADD COLUMN space TEXT");
    d.exec(`UPDATE notes SET parent_id = json_extract(json, '$.parentId'), space = json_extract(json, '$.space') WHERE json IS NOT NULL AND json_valid(json)`);
  }
  d.exec("CREATE INDEX IF NOT EXISTS notes_parent ON notes(ws, parent_id)");
  // The interface language rides with a Design sign-in code (older code rows simply have none).
  const oidc = new Set((d.prepare("PRAGMA table_info(oidc_codes)").all() as { name: string }[]).map((c) => c.name));
  if (!oidc.has("locale")) d.exec("ALTER TABLE oidc_codes ADD COLUMN locale TEXT");
  // Reports may name an uploaded file: the kind CHECK is widened by rebuilding the table once.
  const reports = d.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'reports'").get() as { sql: string } | undefined;
  if (reports && !reports.sql.includes("'file'")) {
    d.exec("BEGIN IMMEDIATE");
    try {
      d.exec("ALTER TABLE reports RENAME TO reports_old");
      d.exec(reports.sql.replace("'design')", "'design', 'file')"));
      d.exec("INSERT INTO reports SELECT * FROM reports_old");
      d.exec("DROP TABLE reports_old");
      d.exec("CREATE INDEX IF NOT EXISTS reports_status ON reports(status, created_at)");
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
  }
}

let db: DatabaseSyncT | null = null;
let openedPath = "";
const stmts = new Map<string, StatementSync>();

/** The open database (created and migrated on first use). */
export function store(): DatabaseSyncT {
  const path = storePath();
  if (db && openedPath === path) return db;
  if (db) {
    try {
      db.close();
    } catch {
      // Already closed.
    }
    stmts.clear();
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const d = new DatabaseSync(path);
  d.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  d.exec(SCHEMA);
  migrate(d);
  migrateProjects(d);
  renameLegacyValues(d);
  db = d;
  openedPath = path;
  return d;
}

/** Cached prepared statement. */
export function sql(text: string): StatementSync {
  const d = store();
  let s = stmts.get(text);
  if (!s) {
    s = d.prepare(text);
    stmts.set(text, s);
  }
  return s;
}

/** Runs `fn` in one transaction (all or nothing). Nested calls join the outer one. */
let depth = 0;
export function tx<T>(fn: () => T): T {
  const d = store();
  if (depth > 0) return fn();
  d.exec("BEGIN IMMEDIATE");
  depth++;
  try {
    const out = fn();
    d.exec("COMMIT");
    return out;
  } catch (e) {
    try {
      d.exec("ROLLBACK");
    } catch {
      // Nothing to roll back.
    }
    throw e;
  } finally {
    depth--;
  }
}

let lastSweep = 0;
/** Drops expired sessions, OAuth states, e-mail sign-ins, codes and stale presence (at most once a minute). */
export function sweepExpired(now = Date.now()): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  sql("DELETE FROM sessions WHERE exp < ?").run(now);
  sql("DELETE FROM oauth_state WHERE exp < ?").run(now);
  sql("DELETE FROM email_signin WHERE exp < ?").run(now);
  sql("DELETE FROM oidc_codes WHERE exp < ?").run(now);
  sql("DELETE FROM presence WHERE at < ?").run(now - 120_000);
}

/** One line in the security journal (ids only). */
export function audit(actor: string | null, action: string, target: string | null = null, meta: Record<string, unknown> | null = null): void {
  try {
    sql("INSERT INTO audit (at, actor, action, target, meta) VALUES (?, ?, ?, ?, ?)").run(Date.now(), actor, action, target, meta ? JSON.stringify(meta) : null);
  } catch {
    // The journal never breaks the action it records.
  }
}

/** A random URL-safe id. */
export function newId(bytes = 16): string {
  const { randomBytes } = process.getBuiltinModule("node:crypto") as typeof import("node:crypto");
  return randomBytes(bytes).toString("base64url");
}
