// Zvena Projects: the tables of the issue tracker (teams, workflows, issues,
// projects, cycles, comments, history, notifications, saved views…).
//
// They live in the same SQLite file as accounts and workspaces and hang off
// `workspaces` and `users` with foreign keys: deleting a workspace removes its
// teams, issues and everything under them; deleting an account unassigns its
// issues and drops its notifications. Every row that a request can name by id
// carries `ws_id`, so each query is scoped to one workspace (no id from
// another workspace ever resolves).
//
// Migrations are numbered steps recorded in `kv` ('pj:schema'); a step runs
// once, inside a transaction. Add new steps at the end, never edit old ones.

import type { DatabaseSync } from "node:sqlite";

const V1 = `
CREATE TABLE IF NOT EXISTS pj_teams (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,                       -- issue prefix: ZVN → ZVN-123
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#5e6ad2',
  icon TEXT,                               -- an emoji, or NULL (the key's first letter)
  private INTEGER NOT NULL DEFAULT 0,      -- 1: only team members (and the workspace owner) see it
  issue_seq INTEGER NOT NULL DEFAULT 0,    -- the last issue number given out
  estimates TEXT NOT NULL DEFAULT 'fibonacci' CHECK (estimates IN ('none', 'linear', 'fibonacci', 'exponential', 'tshirt')),
  cycles_enabled INTEGER NOT NULL DEFAULT 1,
  cycle_weeks INTEGER NOT NULL DEFAULT 2 CHECK (cycle_weeks BETWEEN 1 AND 8),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS pj_teams_key ON pj_teams(ws_id, key);

CREATE TABLE IF NOT EXISTS pj_team_members (
  team_id TEXT NOT NULL REFERENCES pj_teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('lead', 'member')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS pj_team_members_user ON pj_team_members(user_id);

-- The team's workflow: statuses in board order, each in one category
-- (the category, not the name, decides what "done" or "active" means).
CREATE TABLE IF NOT EXISTS pj_statuses (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES pj_teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('backlog', 'unstarted', 'started', 'completed', 'canceled')),
  color TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pj_statuses_team ON pj_statuses(team_id, position);

-- Labels of the workspace (team_id NULL) or of one team; a label with
-- is_group = 1 groups others (parent_id), and an issue takes one per group.
CREATE TABLE IF NOT EXISTS pj_labels (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id TEXT REFERENCES pj_teams(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES pj_labels(id) ON DELETE CASCADE,
  is_group INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS pj_labels_name ON pj_labels(ws_id, IFNULL(team_id, ''), name);

CREATE TABLE IF NOT EXISTS pj_projects (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  icon TEXT,
  color TEXT NOT NULL DEFAULT '#5e6ad2',
  state TEXT NOT NULL DEFAULT 'planned' CHECK (state IN ('backlog', 'planned', 'started', 'paused', 'completed', 'canceled')),
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4),
  health TEXT CHECK (health IN ('on_track', 'at_risk', 'off_track')),
  lead_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  start_date TEXT,                         -- YYYY-MM-DD
  target_date TEXT,
  sort_order REAL NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  canceled_at INTEGER,
  archived_at INTEGER
);
CREATE INDEX IF NOT EXISTS pj_projects_ws ON pj_projects(ws_id, archived_at, sort_order);

CREATE TABLE IF NOT EXISTS pj_project_teams (
  project_id TEXT NOT NULL REFERENCES pj_projects(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES pj_teams(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, team_id)
);
CREATE INDEX IF NOT EXISTS pj_project_teams_team ON pj_project_teams(team_id);

CREATE TABLE IF NOT EXISTS pj_project_members (
  project_id TEXT NOT NULL REFERENCES pj_projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, user_id)
);

-- "Project A waits for project B" (shown on the roadmap).
CREATE TABLE IF NOT EXISTS pj_project_deps (
  project_id TEXT NOT NULL REFERENCES pj_projects(id) ON DELETE CASCADE,
  depends_on TEXT NOT NULL REFERENCES pj_projects(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, depends_on),
  CHECK (project_id <> depends_on)
);

CREATE TABLE IF NOT EXISTS pj_milestones (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES pj_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  target_date TEXT,
  sort_order REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pj_milestones_project ON pj_milestones(project_id, sort_order);

CREATE TABLE IF NOT EXISTS pj_project_updates (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES pj_projects(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  health TEXT NOT NULL CHECK (health IN ('on_track', 'at_risk', 'off_track')),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pj_project_updates_project ON pj_project_updates(project_id, created_at);

CREATE TABLE IF NOT EXISTS pj_cycles (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES pj_teams(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  starts_on TEXT NOT NULL,                 -- YYYY-MM-DD, inclusive
  ends_on TEXT NOT NULL,                   -- YYYY-MM-DD, inclusive
  completed_at INTEGER,
  summary TEXT,                            -- JSON written when the cycle is completed
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (team_id, number),
  CHECK (ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS pj_cycles_team ON pj_cycles(team_id, starts_on);

CREATE TABLE IF NOT EXISTS pj_issues (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES pj_teams(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',    -- Markdown (mentions: [@ id="…" label="…"])
  status_id TEXT NOT NULL REFERENCES pj_statuses(id),
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4),  -- 0 none, 1 urgent … 4 low
  estimate INTEGER CHECK (estimate IS NULL OR estimate BETWEEN 0 AND 1000),
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  creator_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES pj_projects(id) ON DELETE SET NULL,
  milestone_id TEXT REFERENCES pj_milestones(id) ON DELETE SET NULL,
  cycle_id TEXT REFERENCES pj_cycles(id) ON DELETE SET NULL,
  parent_id TEXT REFERENCES pj_issues(id) ON DELETE SET NULL,
  due_date TEXT,                           -- YYYY-MM-DD
  sort_order REAL NOT NULL,                -- manual order (board columns, list)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status_changed_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  canceled_at INTEGER,
  archived_at INTEGER,
  fts_id INTEGER NOT NULL UNIQUE,          -- the issue's row in pj_issues_fts (stable, unlike rowid)
  UNIQUE (team_id, number),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX IF NOT EXISTS pj_issues_ws_updated ON pj_issues(ws_id, updated_at);
CREATE INDEX IF NOT EXISTS pj_issues_team_status ON pj_issues(team_id, status_id, sort_order);
CREATE INDEX IF NOT EXISTS pj_issues_status ON pj_issues(status_id);
CREATE INDEX IF NOT EXISTS pj_issues_assignee ON pj_issues(ws_id, assignee_id);
CREATE INDEX IF NOT EXISTS pj_issues_creator ON pj_issues(ws_id, creator_id);
CREATE INDEX IF NOT EXISTS pj_issues_project ON pj_issues(project_id);
CREATE INDEX IF NOT EXISTS pj_issues_cycle ON pj_issues(cycle_id);
CREATE INDEX IF NOT EXISTS pj_issues_parent ON pj_issues(parent_id);
CREATE INDEX IF NOT EXISTS pj_issues_due ON pj_issues(ws_id, due_date) WHERE due_date IS NOT NULL;

-- Identifiers an issue had before it moved to another team (old links keep working).
CREATE TABLE IF NOT EXISTS pj_issue_aliases (
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  identifier TEXT NOT NULL,
  issue_id TEXT NOT NULL REFERENCES pj_issues(id) ON DELETE CASCADE,
  PRIMARY KEY (ws_id, identifier)
);

CREATE TABLE IF NOT EXISTS pj_issue_labels (
  issue_id TEXT NOT NULL REFERENCES pj_issues(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES pj_labels(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, label_id)
);
CREATE INDEX IF NOT EXISTS pj_issue_labels_label ON pj_issue_labels(label_id);

CREATE TABLE IF NOT EXISTS pj_issue_subscribers (
  issue_id TEXT NOT NULL REFERENCES pj_issues(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted INTEGER NOT NULL DEFAULT 0,        -- 1: unsubscribed on purpose (not re-added automatically)
  PRIMARY KEY (issue_id, user_id)
);
CREATE INDEX IF NOT EXISTS pj_issue_subscribers_user ON pj_issue_subscribers(user_id);

-- blocks: issue_id blocks related_id ("blocked by" is the reverse);
-- related and duplicate (issue_id duplicates related_id).
CREATE TABLE IF NOT EXISTS pj_issue_relations (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issue_id TEXT NOT NULL REFERENCES pj_issues(id) ON DELETE CASCADE,
  related_id TEXT NOT NULL REFERENCES pj_issues(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('blocks', 'related', 'duplicate')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (issue_id, related_id, type),
  CHECK (issue_id <> related_id)
);
CREATE INDEX IF NOT EXISTS pj_issue_relations_related ON pj_issue_relations(related_id);

CREATE TABLE IF NOT EXISTS pj_comments (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issue_id TEXT NOT NULL REFERENCES pj_issues(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  parent_id TEXT REFERENCES pj_comments(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  edited_at INTEGER
);
CREATE INDEX IF NOT EXISTS pj_comments_issue ON pj_comments(issue_id, created_at);

CREATE TABLE IF NOT EXISTS pj_reactions (
  comment_id TEXT NOT NULL REFERENCES pj_comments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, user_id, emoji)
);

-- The issue's history: one row per change (old and new value as JSON).
CREATE TABLE IF NOT EXISTS pj_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issue_id TEXT NOT NULL REFERENCES pj_issues(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  from_value TEXT,
  to_value TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pj_activity_issue ON pj_activity(issue_id, id);

-- Files attached to an issue. The bytes are the content-addressed files of
-- Documents (one copy per content); access always goes through the issue.
CREATE TABLE IF NOT EXISTS pj_attachments (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issue_id TEXT NOT NULL REFERENCES pj_issues(id) ON DELETE CASCADE,
  file TEXT NOT NULL,                      -- <sha1>.<ext> in the files directory
  name TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pj_attachments_issue ON pj_attachments(issue_id);

CREATE TABLE IF NOT EXISTS pj_notifications (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  issue_id TEXT REFERENCES pj_issues(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES pj_projects(id) ON DELETE CASCADE,
  comment_id TEXT REFERENCES pj_comments(id) ON DELETE CASCADE,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  read_at INTEGER,
  archived_at INTEGER,
  snoozed_until INTEGER
);
CREATE INDEX IF NOT EXISTS pj_notifications_inbox ON pj_notifications(user_id, ws_id, archived_at, updated_at);
CREATE INDEX IF NOT EXISTS pj_notifications_issue ON pj_notifications(issue_id);

-- Reminders already sent (due soon / overdue), so the hourly job never repeats one.
CREATE TABLE IF NOT EXISTS pj_reminders (
  issue_id TEXT NOT NULL REFERENCES pj_issues(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  due_date TEXT NOT NULL,
  PRIMARY KEY (issue_id, kind, due_date)
);

CREATE TABLE IF NOT EXISTS pj_views (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shared INTEGER NOT NULL DEFAULT 0,       -- 1: every member of the workspace sees it
  team_id TEXT REFERENCES pj_teams(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES pj_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT,
  color TEXT NOT NULL DEFAULT '#5e6ad2',
  filters TEXT NOT NULL DEFAULT '{}',      -- JSON (lib/projects/filter.ts)
  display TEXT NOT NULL DEFAULT '{}',      -- JSON: layout, grouping, ordering, columns
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pj_views_ws ON pj_views(ws_id, owner_id);

CREATE TABLE IF NOT EXISTS pj_favorites (
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('issue', 'project', 'view', 'cycle', 'team')),
  target_id TEXT NOT NULL,
  sort_order REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, target_id)
);

-- Custom fields of the workspace (team_id NULL) or a team, and their values.
CREATE TABLE IF NOT EXISTS pj_fields (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id TEXT REFERENCES pj_teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'number', 'date', 'select', 'checkbox', 'url')),
  options TEXT NOT NULL DEFAULT '[]',      -- JSON: [{ id, name, color }] for select
  sort_order REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX IF NOT EXISTS pj_fields_ws ON pj_fields(ws_id);

CREATE TABLE IF NOT EXISTS pj_field_values (
  issue_id TEXT NOT NULL REFERENCES pj_issues(id) ON DELETE CASCADE,
  field_id TEXT NOT NULL REFERENCES pj_fields(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  PRIMARY KEY (issue_id, field_id)
);

-- A change counter per workspace: open pages poll it and refresh when it moves.
CREATE TABLE IF NOT EXISTS pj_changes (
  ws_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL
);

-- Full-text search over titles and descriptions (trigram: substrings, any
-- language, case-insensitive), keyed by pj_issues.fts_id and kept in step by
-- triggers.
CREATE VIRTUAL TABLE IF NOT EXISTS pj_issues_fts USING fts5(title, description, tokenize='trigram remove_diacritics 1');
CREATE TRIGGER IF NOT EXISTS pj_issues_fts_ai AFTER INSERT ON pj_issues BEGIN
  INSERT INTO pj_issues_fts(rowid, title, description) VALUES (new.fts_id, new.title, new.description);
END;
CREATE TRIGGER IF NOT EXISTS pj_issues_fts_ad AFTER DELETE ON pj_issues BEGIN
  DELETE FROM pj_issues_fts WHERE rowid = old.fts_id;
END;
CREATE TRIGGER IF NOT EXISTS pj_issues_fts_au AFTER UPDATE OF title, description ON pj_issues BEGIN
  UPDATE pj_issues_fts SET title = new.title, description = new.description WHERE rowid = new.fts_id;
END;
`;

// V2: indexes behind foreign keys that cascade, and the workspace's comment
// authors. Without them deleting a comment (its replies, its notifications)
// scanned every comment of every workspace, and people() did too.
const V2 = `
CREATE INDEX IF NOT EXISTS pj_comments_parent ON pj_comments(parent_id);
CREATE INDEX IF NOT EXISTS pj_comments_ws_author ON pj_comments(ws_id, author_id);
CREATE INDEX IF NOT EXISTS pj_notifications_comment ON pj_notifications(comment_id);
CREATE INDEX IF NOT EXISTS pj_notifications_project ON pj_notifications(project_id);
CREATE INDEX IF NOT EXISTS pj_issues_milestone ON pj_issues(milestone_id);
`;

// V3: Jev's autopilot. History rows say who acted through whom (`via`
// 'jev': Jev changed it on the person's behalf); suggestions Jev made on an
// issue, open or resolved, with the value before an automatic change (Undo).
const V3 = `
ALTER TABLE pj_activity ADD COLUMN via TEXT;
CREATE TABLE IF NOT EXISTS pj_suggestions (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issue_id TEXT NOT NULL REFERENCES pj_issues(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                      -- priority | label | project | assignee | duplicate | done
  value TEXT NOT NULL,                     -- JSON: what Jev proposes
  prev TEXT,                               -- JSON: the value before an automatic change
  confidence REAL NOT NULL,
  model TEXT NOT NULL,
  state TEXT NOT NULL,                     -- open | applied | accepted | dismissed | undone
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS pj_suggestions_issue ON pj_suggestions(issue_id, state);
`;

// V4: goals move by themselves (lib/projects/goals.ts). A project completed by
// zvena when its last issue closed (reopening work undoes only that), and the
// automatic updates it writes ('met' | 'reopened'; their words are the reader's).
const V4 = `
ALTER TABLE pj_projects ADD COLUMN auto_completed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pj_project_updates ADD COLUMN auto TEXT;
`;

// V5: Triage, a team's intake. With it on, issues from people outside the
// team (or sent there on purpose) wait in triage_at until someone accepts,
// declines, marks them duplicate, or snoozes them (triage_snoozed_until).
const V5 = `
ALTER TABLE pj_teams ADD COLUMN triage INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pj_issues ADD COLUMN triage_at INTEGER;
ALTER TABLE pj_issues ADD COLUMN triage_snoozed_until INTEGER;
CREATE INDEX IF NOT EXISTS pj_issues_triage ON pj_issues(team_id, triage_at) WHERE triage_at IS NOT NULL;
`;

// V6: lines of a document that "Goals from a document" turned into issues,
// waiting for an editor of the page to swap them for live issue blocks (the
// page is co-edited, so only an open editor may change its body).
const V6 = `
CREATE TABLE IF NOT EXISTS pj_doc_conversions (
  ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  issue_id TEXT NOT NULL REFERENCES pj_issues(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (ws_id, note_id, block_id)
);
`;

const MIGRATIONS: readonly string[] = [V1, V2, V3, V4, V5, V6];

/** Brings the Projects tables up to date (called once when the store opens). */
export function migrateProjects(d: DatabaseSync): void {
  const row = d.prepare("SELECT v FROM kv WHERE k = 'pj:schema'").get() as { v: string } | undefined;
  let v = row ? Number(row.v) || 0 : 0;
  while (v < MIGRATIONS.length) {
    d.exec("BEGIN IMMEDIATE");
    try {
      d.exec(MIGRATIONS[v]);
      v++;
      d.prepare("INSERT INTO kv (k, v) VALUES ('pj:schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(v));
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
  }
}
