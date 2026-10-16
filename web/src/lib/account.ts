// Server-only: deleting an account (the person's right to erasure).
//
// Shared workspaces the person owns go to the next member (editors first,
// then commenters, then viewers, oldest first) so the team keeps its work;
// a workspace nobody else is in is deleted with its documents and designs.
// Then the person's files that nobody else stores (files the remaining
// workspaces still show pass to their owners first), their Design profile and
// finally the account itself (identities, sessions, settings cascade; Mail's
// mailboxes, their credentials and all their mail through mail_user_gone;
// calendars through cal_user_gone). Every table with a person's own rows is
// checked by tests/unit/account-erasure.test.ts.
// Design down: the zvena side is still erased at once and the Design
// profile deletion waits in a retry queue (cleanup job).

import { revokeAllClippers } from "./clipper";
import { syncWorkspaceDesign } from "./design-sync";
import { deleteProfile, deleteTeam, designConfigured } from "./penpot";
import { dropUserFiles, handOverFiles } from "./storage";
import { audit, sql, tx } from "./store";
import { dropUserDocsPrefs } from "./notes/follows";
import { deleteWorkspace, workspacesOf } from "./workspaces";

const hasTable = (name: string) => Boolean(sql("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

/** Rows kept per person in tables other modules create on first use (they may not exist yet). */
function dropIfTable(table: string, where: string, ...args: string[]): void {
  if (hasTable(table)) sql(`DELETE FROM ${table} WHERE ${where}`).run(...args);
}

const ROLE_ORDER = "CASE role WHEN 'editor' THEN 0 WHEN 'commenter' THEN 1 ELSE 2 END";

function queueDesignDeletion(userId: string): void {
  const row = sql("SELECT v FROM kv WHERE k = 'design-deletions'").get() as { v: string } | undefined;
  const list = new Set<string>(row ? (JSON.parse(row.v) as string[]) : []);
  list.add(userId);
  sql("INSERT INTO kv (k, v) VALUES ('design-deletions', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify([...list]));
}

/** Retries queued Design profile deletions; returns how many are still waiting. */
export async function retryDesignDeletions(): Promise<number> {
  const row = sql("SELECT v FROM kv WHERE k = 'design-deletions'").get() as { v: string } | undefined;
  if (!row || !designConfigured()) return row ? (JSON.parse(row.v) as string[]).length : 0;
  const left: string[] = [];
  for (const id of JSON.parse(row.v) as string[]) {
    try {
      await deleteProfile(id);
    } catch {
      left.push(id);
    }
  }
  sql("UPDATE kv SET v = ? WHERE k = 'design-deletions'").run(JSON.stringify(left));
  return left.length;
}

export async function deleteAccount(userId: string): Promise<void> {
  const teamsToDelete: string[] = [];
  const toSync: string[] = [];
  const spaces = workspacesOf(userId);
  for (const w of spaces) {
    if (w.role !== "owner") {
      sql("DELETE FROM members WHERE ws_id = ? AND user_id = ?").run(w.id, userId);
      toSync.push(w.id);
      continue;
    }
    const next = w.personal
      ? undefined
      : (sql(`SELECT user_id FROM members WHERE ws_id = ? AND user_id != ? ORDER BY ${ROLE_ORDER}, created_at LIMIT 1`).get(w.id, userId) as { user_id: string } | undefined);
    if (next) {
      tx(() => {
        sql("UPDATE members SET role = 'owner' WHERE ws_id = ? AND user_id = ?").run(w.id, next.user_id);
        sql("UPDATE workspaces SET owner_id = ? WHERE id = ?").run(next.user_id, w.id);
        sql("DELETE FROM members WHERE ws_id = ? AND user_id = ?").run(w.id, userId);
      });
      toSync.push(w.id);
    } else {
      const team = sql("SELECT penpot_team_id FROM workspaces WHERE id = ?").get(w.id) as { penpot_team_id: string | null } | undefined;
      // The personal workspace's team is the profile's own: it goes with the profile.
      if (team?.penpot_team_id && !w.personal) teamsToDelete.push(team.penpot_team_id);
      deleteWorkspace(userId, w.id);
    }
  }
  // Files the person paid for that the remaining workspaces still show stay (their owners pay now).
  handOverFiles(userId, spaces.map((w) => w.id));
  await dropUserFiles(userId);
  let designOk = true;
  if (designConfigured()) {
    try {
      for (const ws of toSync) await syncWorkspaceDesign(ws);
      for (const team of teamsToDelete) await deleteTeam(team);
      await deleteProfile(userId);
    } catch {
      designOk = false;
    }
  }
  if (!designOk) queueDesignDeletion(userId);
  // Mail: the workers stop and draft files go; its rows and mailbox credentials go with the user row (mail_user_gone).
  const { forgetMailOf } = await import("./mail-client/accounts");
  await forgetMailOf(userId);
  tx(() => {
    // Attachment rows go with their message (mail_messages_gone); any left without one go too.
    dropIfTable("mail_attachments", "user_id = ?", userId);
    sql("DELETE FROM presence WHERE user_id = ?").run(userId);
    sql("DELETE FROM note_favorites WHERE user_id = ?").run(userId);
    // Which pages the person opened (Analytics) is theirs; versions they wrote stay with the team.
    sql("DELETE FROM note_views WHERE user_id = ?").run(userId);
    // Documents' notification settings and followed pages.
    dropUserDocsPrefs(userId);
    // Page shares (as a member or a guest) and teamspace places.
    sql("DELETE FROM note_grants WHERE user_id = ?").run(userId);
    sql("DELETE FROM note_revoked WHERE user_id = ?").run(userId);
    sql("DELETE FROM teamspace_members WHERE user_id = ?").run(userId);
    sql("DELETE FROM ws_group_members WHERE user_id = ?").run(userId);
    sql("DELETE FROM note_access_requests WHERE user_id = ?").run(userId);
    sql("DELETE FROM oidc_codes WHERE user_id = ?").run(userId);
    // Their time zone, page reminders and when the last e-mail digest went out.
    sql("DELETE FROM user_tz WHERE user_id = ?").run(userId);
    sql("DELETE FROM note_reminders WHERE user_id = ?").run(userId);
    dropIfTable("note_mail_digest", "user_id = ?", userId);
    // Which workspaces' old page stars were taken over for them (a marker naming their id).
    sql("DELETE FROM kv WHERE k LIKE 'fav-migrated:%' AND substr(k, -length(?) - 1) = ':' || ?").run(userId, userId);
    // Live numbers counted from their mail (mail is theirs alone), and meetings they had turn into issues.
    if (hasTable("dz_sources")) {
      sql("DELETE FROM dz_metrics WHERE (ws, key) IN (SELECT ws, key FROM dz_sources WHERE created_by = ? AND json_extract(json, '$.kind') = 'mail')").run(userId);
      sql("DELETE FROM dz_sources WHERE created_by = ? AND json_extract(json, '$.kind') = 'mail'").run(userId);
    }
    dropIfTable("dz_flows", "by = ?", userId);
    // Connected Web Clippers stop with the account (and sign-in codes not yet exchanged).
    revokeAllClippers(userId);
    dropIfTable("clipper_codes", "user_id = ?", userId);
    sql("UPDATE reports SET reporter_id = NULL WHERE reporter_id = ?").run(userId);
    sql("DELETE FROM audit WHERE actor = ?").run(userId);
    sql("DELETE FROM users WHERE id = ?").run(userId);
  });
  // No id of the person is kept: the journal notes that an account was deleted.
  audit(null, "account.delete", null, { design: designOk ? "deleted" : "queued" });
}
