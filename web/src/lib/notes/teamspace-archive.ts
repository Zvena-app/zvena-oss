// Server-only: archived teamspaces (Notion's "Archive teamspace"). An
// archived teamspace leaves everyone's sidebar; its pages stay where they
// are (search and links still open them) and its managers may restore it.

import { sql } from "../store";

let ready = false;
function ensureTables(): void {
  if (ready) return;
  sql("CREATE TABLE IF NOT EXISTS teamspace_archive (ts_id TEXT PRIMARY KEY, ws TEXT NOT NULL, at INTEGER NOT NULL, by TEXT NOT NULL)").run();
  sql("CREATE INDEX IF NOT EXISTS teamspace_archive_ws ON teamspace_archive(ws)").run();
  ready = true;
}

/** The archived teamspaces of a workspace. */
export function archivedTeamspaces(ws: string): Set<string> {
  ensureTables();
  return new Set((sql("SELECT ts_id FROM teamspace_archive WHERE ws = ?").all(ws) as { ts_id: string }[]).map((r) => r.ts_id));
}

export function setTeamspaceArchived(ws: string, id: string, actor: string, on: boolean, now = Date.now()): void {
  ensureTables();
  if (on) sql("INSERT INTO teamspace_archive (ts_id, ws, at, by) VALUES (?, ?, ?, ?) ON CONFLICT(ts_id) DO NOTHING").run(id, ws, now, actor);
  else sql("DELETE FROM teamspace_archive WHERE ts_id = ? AND ws = ?").run(id, ws);
}

/** A teamspace (or a whole workspace) deleted: its archive mark goes too. */
export function dropTeamspaceArchive(ws: string, id?: string): void {
  ensureTables();
  if (id) sql("DELETE FROM teamspace_archive WHERE ts_id = ? AND ws = ?").run(id, ws);
  else sql("DELETE FROM teamspace_archive WHERE ws = ?").run(ws);
}
