// The ecosystem's tables. Server-only. They live in zvena's one SQLite file
// next to the products' own tables and only ever hold ids, titles and the
// text needed for search (never a copy of what a product owns):
//
//   eco_links      who points at whom, across products (src → dst ref keys)
//   eco_docs       a catalog of a workspace's Documents notes (title, icon,
//                  parent, trash) so cards and search never parse page JSON
//   eco_search     full-text search over the catalog (trigram: any language)
//   eco_index      how far each workspace has been indexed
//   eco_inbox      notifications of Documents and Design (Projects has its own)
//
// Migrations are numbered steps recorded in `kv` ('eco:schema'), created on
// first use (the store opens without them). Add new steps at the end.

import type { DatabaseSync } from "node:sqlite";
import { store } from "../store";

const V1 = `
CREATE TABLE IF NOT EXISTS eco_links (
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  src TEXT NOT NULL,
  -- where inside src: '' = the body, 'c:<comment id>' = an issue comment
  part TEXT NOT NULL DEFAULT '',
  dst TEXT NOT NULL,
  via TEXT NOT NULL CHECK (via IN ('mention', 'link', 'embed', 'relation', 'converted', 'manual')),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (ws_id, src, part, dst, via)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS eco_links_dst ON eco_links(ws_id, dst);

CREATE TABLE IF NOT EXISTS eco_docs (
  fts_id INTEGER PRIMARY KEY,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL,
  parent_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  -- 1: a database row, 2: hidden (a template or a synced block's content)
  flags INTEGER NOT NULL DEFAULT 0,
  trashed_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (ws_id, note_id)
);
CREATE INDEX IF NOT EXISTS eco_docs_parent ON eco_docs(ws_id, parent_id);
CREATE VIRTUAL TABLE IF NOT EXISTS eco_docs_fts USING fts5(title, body, tokenize='trigram remove_diacritics 1');
CREATE TRIGGER IF NOT EXISTS eco_docs_ad AFTER DELETE ON eco_docs BEGIN
  DELETE FROM eco_docs_fts WHERE rowid = old.fts_id;
END;

CREATE TABLE IF NOT EXISTS eco_index (
  ws_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  at INTEGER NOT NULL
);
`;

// The ecosystem's own notifications (Documents, Design…); Projects keeps its
// own (pj_notifications) and the Inbox shows both as one list.
const V2 = `
CREATE TABLE IF NOT EXISTS eco_inbox (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  part TEXT NOT NULL DEFAULT '',
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  text TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  read_at INTEGER,
  archived_at INTEGER
);
CREATE INDEX IF NOT EXISTS eco_inbox_user ON eco_inbox(user_id, ws_id, archived_at, updated_at);
CREATE INDEX IF NOT EXISTS eco_inbox_same ON eco_inbox(user_id, ws_id, kind, ref, part) WHERE read_at IS NULL;
`;

// Catching up after a restart or a missed poke (high-water marks per
// workspace), a database's relation/person properties (its rows are indexed
// again when they change), and a deleted account leaves no trace in links.
const V3 = `
ALTER TABLE eco_index ADD COLUMN notes_stamp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE eco_index ADD COLUMN pj_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE eco_docs ADD COLUMN sig TEXT NOT NULL DEFAULT '';
CREATE TRIGGER IF NOT EXISTS eco_user_gone AFTER DELETE ON users BEGIN
  DELETE FROM eco_links WHERE dst = 'user:' || old.id OR src = 'user:' || old.id;
  UPDATE eco_links SET created_by = NULL WHERE created_by = old.id;
END;
`;

// Speed (measured on 7k notes, 128k links, 200k search rows across workspaces):
// - backlinks ordered by time from the index itself;
// - search narrowed to the workspace inside the full-text index (the workspace
//   is a column: a phrase match on it; the exact ws_id filter stays, since the
//   trigram tokenizer ignores case);
// - a note's text and an issue part's text are fingerprinted, so unchanged text
//   is never rewritten; the stamp a note was indexed at lets a restarted
//   backfill skip what it already did.
const V4 = `
CREATE INDEX IF NOT EXISTS eco_links_dst_at ON eco_links(ws_id, dst, created_at);
DROP INDEX IF EXISTS eco_links_dst;
CREATE VIRTUAL TABLE IF NOT EXISTS eco_search USING fts5(ws, title, body, tokenize='trigram remove_diacritics 1');
INSERT INTO eco_search (rowid, ws, title, body) SELECT f.rowid, d.ws_id, f.title, f.body FROM eco_docs_fts f JOIN eco_docs d ON d.fts_id = f.rowid;
DROP TRIGGER IF EXISTS eco_docs_ad;
DROP TABLE IF EXISTS eco_docs_fts;
CREATE TRIGGER IF NOT EXISTS eco_docs_gone AFTER DELETE ON eco_docs BEGIN
  DELETE FROM eco_search WHERE rowid = old.fts_id;
END;
ALTER TABLE eco_docs ADD COLUMN text_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE eco_docs ADD COLUMN stamp INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS eco_parts (
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  src TEXT NOT NULL,
  part TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (ws_id, src, part)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS eco_inbox_unread ON eco_inbox(user_id, ws_id, read_at, archived_at);
`;

// V5: Inbox rows by what they are about — deleting an object (a calendar event's
// trigger) or dropping a workspace's items no longer scans every person's Inbox.
const V5 = `
CREATE INDEX IF NOT EXISTS eco_inbox_ws_ref ON eco_inbox (ws_id, ref);
`;

// V6: which issue a Design comment thread became (one issue per thread; its
// close resolves the thread, its reopening reopens it).
const V6 = `
CREATE TABLE IF NOT EXISTS eco_design_threads (
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ws_id, thread_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS eco_design_threads_issue ON eco_design_threads (ws_id, issue_id);
`;

const MIGRATIONS: readonly string[] = [V1, V2, V3, V4, V5, V6];

/** Bumped when what the indexer extracts changes: workspaces are indexed again. */
export const INDEX_VERSION = 1;

const KEY = Symbol.for("zvena.eco.schema");
const g = globalThis as unknown as Record<symbol, DatabaseSync | undefined>;

function migrate(d: DatabaseSync): void {
  const row = d.prepare("SELECT v FROM kv WHERE k = 'eco:schema'").get() as { v: string } | undefined;
  let v = row ? Number(row.v) || 0 : 0;
  while (v < MIGRATIONS.length) {
    d.exec("BEGIN IMMEDIATE");
    try {
      d.exec(MIGRATIONS[v]);
      v++;
      d.prepare("INSERT INTO kv (k, v) VALUES ('eco:schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(v));
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
  }
}

/** The store, with the ecosystem's tables up to date (once per database file). */
export function ecoDb(): DatabaseSync {
  const d = store();
  if (g[KEY] !== d) {
    migrate(d);
    g[KEY] = d;
  }
  return d;
}
