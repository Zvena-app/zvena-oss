// zvena Mail's tables. Server-only. They live in zvena's one SQLite file and
// are created on first use (the store opens without them), as numbered
// steps recorded in `kv` ('mail:schema'); add new steps at the end.
//
//   mail_accounts        a person's mailboxes; `secret` is sealed (crypto.ts)
//   mail_folders         each mailbox's IMAP folders and how far they are synced
//   mail_messages        headers, flags, where a message is (boxes), and its
//                        text once fetched; `n` is the full-text row id
//   mail_refs            the Message-IDs a message names (threading.ts)
//   mail_fts             full-text search over subject, people and body, per owner
//   mail_attachments     what is attached (names, types, sizes, the IMAP part);
//                        the content stays on the mail server until opened
//   mail_labels          IMAP folders and Gmail labels as labels, and zvena's
//                        own labels; mail_message_labels which message has which
//   mail_views           a person's own views (filters)
//   mail_ops             changes waiting to reach the mail server
//   mail_outbox          mail waiting to be sent (undo send, send later)
//   mail_drafts          drafts as the composer saved them
//   mail_uploads         files attached to a draft (on disk until sent)
//   mail_contacts        addresses a person wrote to or heard from (autocomplete)
//   mail_snippets        reusable text (Notion Mail's Snippets)
//   mail_prefs           a person's settings
//   mail_image_senders   senders whose images load without asking
//
// Every row carries its owner (user_id); the API never reads a row without
// it. Deleting an account (lib/account.ts → DELETE FROM users) drops all of
// it, credentials first, through the mail_user_gone trigger; the ecosystem's
// links and notifications about mail go with it.

import type { DatabaseSync } from "node:sqlite";
import { ecoDb } from "../eco/schema";

const V1 = `
CREATE TABLE IF NOT EXISTS mail_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL,
  auth TEXT NOT NULL DEFAULT 'password',
  username TEXT NOT NULL,
  secret TEXT NOT NULL,
  imap_host TEXT NOT NULL,
  imap_port INTEGER NOT NULL,
  imap_tls TEXT NOT NULL,
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL,
  smtp_tls TEXT NOT NULL,
  saves_sent INTEGER NOT NULL DEFAULT 0,
  gmail INTEGER NOT NULL DEFAULT 0,
  signature TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'new',
  error TEXT,
  synced_at INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_accounts_user ON mail_accounts(user_id);

CREATE TABLE IF NOT EXISTS mail_folders (
  account_id TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  delimiter TEXT NOT NULL DEFAULT '/',
  role TEXT,
  uidvalidity TEXT,
  last_uid INTEGER NOT NULL DEFAULT 0,
  modseq TEXT,
  synced_at INTEGER,
  PRIMARY KEY (account_id, path)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS mail_messages (
  n INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  folder TEXT NOT NULL,
  -- the IMAP UID in folder; below 0: not on the server yet (just moved, just sent)
  uid INTEGER NOT NULL,
  msgid TEXT NOT NULL DEFAULT '',
  in_reply_to TEXT NOT NULL DEFAULT '',
  refs TEXT NOT NULL DEFAULT '',
  thread_id TEXT NOT NULL,
  gm_msgid TEXT,
  subject TEXT NOT NULL DEFAULT '',
  from_addr TEXT NOT NULL DEFAULT '',
  from_name TEXT NOT NULL DEFAULT '',
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  bcc_json TEXT NOT NULL DEFAULT '[]',
  reply_to TEXT NOT NULL DEFAULT '',
  date INTEGER NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  -- bits of views.ts BOX: inbox 1, sent 2, drafts 4, trash 8, spam 16
  boxes INTEGER NOT NULL DEFAULT 0,
  seen INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  answered INTEGER NOT NULL DEFAULT 0,
  has_att INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  unsubscribe TEXT NOT NULL DEFAULT '',
  -- the text: 0 not fetched, 1 here, 2 could not be fetched (too big, gone)
  body INTEGER NOT NULL DEFAULT 0,
  text TEXT,
  html TEXT,
  body_bytes INTEGER NOT NULL DEFAULT 0,
  text_part TEXT,
  html_part TEXT,
  snoozed_until INTEGER,
  -- back from snooze at: the conversation sorts as if it had just arrived
  bumped_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS mail_messages_uid ON mail_messages(account_id, folder, uid);
CREATE INDEX IF NOT EXISTS mail_messages_user_date ON mail_messages(user_id, date);
CREATE INDEX IF NOT EXISTS mail_messages_thread ON mail_messages(thread_id, date);
CREATE INDEX IF NOT EXISTS mail_messages_msgid ON mail_messages(account_id, msgid);
CREATE INDEX IF NOT EXISTS mail_messages_snoozed ON mail_messages(snoozed_until) WHERE snoozed_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS mail_messages_body ON mail_messages(user_id, body_bytes) WHERE body_bytes > 0;

CREATE TABLE IF NOT EXISTS mail_refs (
  account_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  message_n INTEGER NOT NULL,
  PRIMARY KEY (account_id, ref, message_n)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS mail_refs_message ON mail_refs(message_n);

CREATE VIRTUAL TABLE IF NOT EXISTS mail_fts USING fts5(subject, people, body, tokenize = 'unicode61 remove_diacritics 2');

CREATE TABLE IF NOT EXISTS mail_attachments (
  id TEXT PRIMARY KEY,
  message_n INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  part TEXT NOT NULL,
  filename TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  cid TEXT,
  inline INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS mail_attachments_message ON mail_attachments(message_n);

CREATE TABLE IF NOT EXISTS mail_labels (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  -- NULL: zvena's own label (on the server only, for every mailbox of the person)
  account_id TEXT REFERENCES mail_accounts(id) ON DELETE CASCADE,
  -- folder: an IMAP folder; gmail: a Gmail label; manual: zvena's
  kind TEXT NOT NULL CHECK (kind IN ('folder', 'gmail', 'manual')),
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS mail_labels_path ON mail_labels(user_id, IFNULL(account_id, ''), kind, path);
CREATE TABLE IF NOT EXISTS mail_message_labels (
  message_n INTEGER NOT NULL,
  label_id TEXT NOT NULL REFERENCES mail_labels(id) ON DELETE CASCADE,
  PRIMARY KEY (message_n, label_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS mail_message_labels_label ON mail_message_labels(label_id);

CREATE TABLE IF NOT EXISTS mail_views (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  filter TEXT NOT NULL,
  notify INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_views_user ON mail_views(user_id, position);

CREATE TABLE IF NOT EXISTS mail_ops (
  id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT '',
  message_ids TEXT NOT NULL DEFAULT '[]',
  arg TEXT NOT NULL DEFAULT '{}',
  tries INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_ops_account ON mail_ops(account_id, next_at);

CREATE TABLE IF NOT EXISTS mail_outbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  send_at INTEGER NOT NULL,
  -- queued | sending | failed
  state TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  envelope TEXT NOT NULL,
  raw BLOB NOT NULL,
  draft TEXT NOT NULL,
  ws TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_outbox_due ON mail_outbox(state, send_at);
CREATE INDEX IF NOT EXISTS mail_outbox_user ON mail_outbox(user_id);

CREATE TABLE IF NOT EXISTS mail_drafts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT,
  json TEXT NOT NULL,
  msgid TEXT NOT NULL,
  imap_folder TEXT,
  imap_uid INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_drafts_user ON mail_drafts(user_id, updated_at);

CREATE TABLE IF NOT EXISTS mail_uploads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_uploads_user ON mail_uploads(user_id);

CREATE TABLE IF NOT EXISTS mail_contacts (
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  -- how often the person wrote to them (counts more) and heard from them
  sent INTEGER NOT NULL DEFAULT 0,
  received INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, email)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS mail_snippets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  html TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_snippets_user ON mail_snippets(user_id);

CREATE TABLE IF NOT EXISTS mail_prefs (
  user_id TEXT PRIMARY KEY,
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_image_senders (
  user_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  PRIMARY KEY (user_id, sender)
) WITHOUT ROWID;

-- Full-text rows go with their message; so do its references, attachments and labels.
CREATE TRIGGER IF NOT EXISTS mail_messages_gone AFTER DELETE ON mail_messages BEGIN
  DELETE FROM mail_fts WHERE rowid = old.n;
  DELETE FROM mail_refs WHERE message_n = old.n;
  DELETE FROM mail_attachments WHERE message_n = old.n;
  DELETE FROM mail_message_labels WHERE message_n = old.n;
END;

-- A deleted zvena account: the ecosystem's links and notifications about its
-- conversations first (they name thread ids), then every mail row, the
-- credentials included. BEFORE: the rows that name the threads are still there.
CREATE TRIGGER IF NOT EXISTS mail_user_gone BEFORE DELETE ON users BEGIN
  DELETE FROM eco_links WHERE src IN (SELECT 'mail:' || thread_id FROM mail_messages WHERE user_id = old.id)
    OR dst IN (SELECT 'mail:' || thread_id FROM mail_messages WHERE user_id = old.id);
  DELETE FROM mail_outbox WHERE user_id = old.id;
  DELETE FROM mail_ops WHERE account_id IN (SELECT id FROM mail_accounts WHERE user_id = old.id);
  DELETE FROM mail_messages WHERE user_id = old.id;
  DELETE FROM mail_labels WHERE user_id = old.id;
  DELETE FROM mail_folders WHERE account_id IN (SELECT id FROM mail_accounts WHERE user_id = old.id);
  DELETE FROM mail_accounts WHERE user_id = old.id;
  DELETE FROM mail_views WHERE user_id = old.id;
  DELETE FROM mail_drafts WHERE user_id = old.id;
  DELETE FROM mail_uploads WHERE user_id = old.id;
  DELETE FROM mail_contacts WHERE user_id = old.id;
  DELETE FROM mail_snippets WHERE user_id = old.id;
  DELETE FROM mail_prefs WHERE user_id = old.id;
  DELETE FROM mail_image_senders WHERE user_id = old.id;
END;
`;

// The Sent copy of a queued message as bytes of its own (it was base64 in the envelope).
const V2 = `
ALTER TABLE mail_outbox ADD COLUMN copy BLOB;
`;

// Full-text rows carry their owner (hex of the user id: one token), so a
// search matches the owner's mail only, inside the index, never everyone's.
const V3 = `
DROP TABLE IF EXISTS mail_fts;
CREATE VIRTUAL TABLE mail_fts USING fts5(owner, subject, people, body, tokenize = 'unicode61 remove_diacritics 2');
INSERT INTO mail_fts (rowid, owner, subject, people, body)
  SELECT n, hex(user_id), subject, from_name || ' ' || from_addr || ' ' || to_json || ' ' || cc_json, substr(COALESCE(text, ''), 1, 100000) FROM mail_messages;
`;

const MIGRATIONS: readonly string[] = [V1, V2, V3];

const KEY = Symbol.for("zvena.mail.schema");
const g = globalThis as unknown as Record<symbol, DatabaseSync | undefined>;

function migrate(d: DatabaseSync): void {
  const row = d.prepare("SELECT v FROM kv WHERE k = 'mail:schema'").get() as { v: string } | undefined;
  let v = row ? Number(row.v) || 0 : 0;
  while (v < MIGRATIONS.length) {
    d.exec("BEGIN IMMEDIATE");
    try {
      d.exec(MIGRATIONS[v]);
      v++;
      d.prepare("INSERT INTO kv (k, v) VALUES ('mail:schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(v));
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
  }
}

/** The store with Mail's tables (and the ecosystem's, which Mail's trigger names), once per database file. */
export function mailDb(): DatabaseSync {
  const d = ecoDb();
  if (g[KEY] !== d) {
    migrate(d);
    g[KEY] = d;
  }
  return d;
}
