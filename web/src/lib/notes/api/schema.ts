// Server-only: the tables of the public API (integrations and the pages
// connected to them). Created on first use, next to the main schema in
// lib/store.ts, so this module stays self-contained.

import { store } from "../../store";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  ws TEXT NOT NULL,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  -- JSON: { read, update, insert, readComments, insertComments, users: "none" | "names" | "emails" }
  caps TEXT NOT NULL,
  -- HMAC of the secret token (the token itself is shown once).
  secret_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  -- Webhooks: an https endpoint, the subscribed event types (JSON array) and
  -- the nonce the signing secret is derived from (the secret is never stored).
  webhook_url TEXT,
  webhook_events TEXT,
  webhook_nonce TEXT
);
CREATE INDEX IF NOT EXISTS integrations_ws ON integrations(ws);
CREATE TABLE IF NOT EXISTS integration_pages (
  integration_id TEXT NOT NULL,
  ws TEXT NOT NULL,
  note_id TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (integration_id, note_id)
);
CREATE INDEX IF NOT EXISTS integration_pages_note ON integration_pages(ws, note_id);
`;

const ready = new WeakSet<object>();

/** Makes sure the API tables exist in the open database. */
export function apiTables(): void {
  const d = store();
  if (ready.has(d)) return;
  d.exec(SCHEMA);
  ready.add(d);
}
