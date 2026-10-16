// The person's side of Projects: the inbox (notifications), saved views,
// favorites, global search and the bootstrap of the app.

import { sql, tx } from "../store";
import { workspaceFor } from "../workspaces";
import { bad, bump, changeSeq, emit, needs, notFound, PjError, pid, str, visibleIssue, visibleProject, type Ctx } from "./core";
import { cleanDisplay, cleanFilter } from "./filter";
import { ftsQuery, issueRefs } from "./issues";
import { parseIdentifier } from "./ident";
import { plainText } from "./markdown";
import { listCycles, listProjects } from "./planning";
import { listFields, listLabels, listStatuses, listTeams } from "./teams";
import { COLOR_RE, dayOf, isDate, type Bootstrap, type Favorite, type Notification, type NotificationKind, type Person, type SavedView, type WsRole } from "./types";

// --- People --------------------------------------------------------------------

/** Members of the workspace, plus people who left but still appear on issues. */
export function people(ctx: Ctx): Person[] {
  const members = sql("SELECT u.id, u.name, u.avatar, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.ws_id = ? ORDER BY u.name COLLATE NOCASE").all(ctx.wsId) as {
    id: string;
    name: string;
    avatar: string | null;
    role: WsRole;
  }[];
  const known = new Set(members.map((m) => m.id));
  const former = sql(
    `SELECT DISTINCT u.id, u.name, u.avatar FROM users u WHERE u.id IN (
       SELECT assignee_id FROM pj_issues WHERE ws_id = ? AND assignee_id IS NOT NULL
       UNION SELECT creator_id FROM pj_issues WHERE ws_id = ? AND creator_id IS NOT NULL
       UNION SELECT author_id FROM pj_comments WHERE ws_id = ? AND author_id IS NOT NULL)`
  ).all(ctx.wsId, ctx.wsId, ctx.wsId) as { id: string; name: string; avatar: string | null }[];
  return [
    ...members.map((m) => ({ id: m.id, name: m.name, avatar: m.avatar, role: m.role })),
    ...former.filter((f) => !known.has(f.id)).map((f) => ({ id: f.id, name: f.name, avatar: f.avatar, role: null })),
  ];
}

// --- Inbox ---------------------------------------------------------------------

interface NotifRow {
  id: string;
  kind: NotificationKind;
  actor_id: string | null;
  issue_id: string | null;
  project_id: string | null;
  comment_id: string | null;
  data: string;
  created_at: number;
  updated_at: number;
  read_at: number | null;
  archived_at: number | null;
  snoozed_until: number | null;
}

export function inbox(ctx: Ctx, opts: { archived?: boolean; limit?: number; before?: number } = {}): { items: (Notification & { excerpt: string })[]; more: boolean } {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const now = Date.now();
  const rows = sql(
    `SELECT id, kind, actor_id, issue_id, project_id, comment_id, data, created_at, updated_at, read_at, archived_at, snoozed_until FROM pj_notifications
     WHERE user_id = ? AND ws_id = ? AND (archived_at IS NULL) = ? AND (snoozed_until IS NULL OR snoozed_until <= ? OR ? = 1) AND updated_at < ?
     ORDER BY updated_at DESC LIMIT ?`
  ).all(ctx.userId, ctx.wsId, opts.archived ? 0 : 1, now, opts.archived ? 1 : 0, opts.before ?? Number.MAX_SAFE_INTEGER, limit + 1) as unknown as NotifRow[];
  const page = rows.slice(0, limit);
  // The autopilot's "possible duplicate": the original, named only if this person sees it.
  const dupOf = (r: NotifRow) => (r.kind === "duplicate" ? String((JSON.parse(r.data) as { of?: unknown }).of ?? "") : "");
  const refs = issueRefs(ctx, [...page.map((r) => r.issue_id), ...page.map(dupOf)].filter((x): x is string => Boolean(x)));
  const prio = new Map(
    (sql("SELECT id, priority FROM pj_issues WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify([...refs.keys()])) as { id: string; priority: number }[]).map((r) => [r.id, r.priority])
  );
  const comments = new Map(
    (sql("SELECT id, body FROM pj_comments WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(page.map((r) => r.comment_id).filter(Boolean))) as { id: string; body: string }[]).map((r) => [
      r.id,
      plainText(r.body, 200),
    ])
  );
  const items = page
    // A notification about an issue the person can no longer see is skipped.
    .filter((r) => !r.issue_id || refs.has(r.issue_id))
    .map((r) => {
      const ref = r.issue_id ? refs.get(r.issue_id) : undefined;
      return {
        id: r.id,
        kind: r.kind,
        actorId: r.actor_id,
        issue: ref ? { ...ref, priority: (prio.get(ref.id) ?? 0) as 0 | 1 | 2 | 3 | 4 } : null,
        projectId: r.project_id,
        commentId: r.comment_id,
        data: r.kind === "duplicate" ? { ...(JSON.parse(r.data) as Record<string, unknown>), of: refs.get(dupOf(r))?.identifier ?? null } : (JSON.parse(r.data) as Record<string, unknown>),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        readAt: r.read_at,
        archivedAt: r.archived_at,
        snoozedUntil: r.snoozed_until,
        excerpt: r.comment_id ? (comments.get(r.comment_id) ?? "") : "",
      };
    });
  return { items, more: rows.length > limit };
}

export function unreadCount(ctx: Ctx): number {
  const r = sql(
    "SELECT COUNT(*) AS n FROM pj_notifications n LEFT JOIN pj_issues i ON i.id = n.issue_id WHERE n.user_id = ? AND n.ws_id = ? AND n.read_at IS NULL AND n.archived_at IS NULL AND (n.snoozed_until IS NULL OR n.snoozed_until <= ?) AND (n.issue_id IS NULL OR i.team_id IN (SELECT value FROM json_each(?)))"
  ).get(ctx.userId, ctx.wsId, Date.now(), JSON.stringify([...ctx.teams()])) as { n: number };
  return Number(r.n);
}

/** Read / unread / archive / unarchive / snooze the person's own notifications. */
export function markNotifications(ctx: Ctx, ids: unknown, action: unknown, until?: unknown): number {
  const now = Date.now();
  const all = ids === "all";
  if (!all && (!Array.isArray(ids) || !ids.length || ids.length > 500)) throw bad("bad ids");
  const set: Record<string, string> = {
    read: "read_at = IFNULL(read_at, ?)",
    unread: "read_at = NULL",
    archive: "archived_at = ?, read_at = IFNULL(read_at, ?)",
    unarchive: "archived_at = NULL",
    snooze: "snoozed_until = ?",
  };
  if (typeof action !== "string" || !Object.hasOwn(set, action)) throw bad("bad action");
  const vals: (string | number | null)[] = [];
  if (action === "read") vals.push(now);
  if (action === "archive") vals.push(now, now);
  if (action === "snooze") {
    const t = Number(until);
    if (!Number.isFinite(t) || t < now || t > now + 90 * 86_400_000) throw bad("bad time");
    vals.push(t);
  }
  const where = all ? "user_id = ? AND ws_id = ? AND archived_at IS NULL" : "user_id = ? AND ws_id = ? AND id IN (SELECT value FROM json_each(?))";
  const params = all ? [ctx.userId, ctx.wsId] : [ctx.userId, ctx.wsId, JSON.stringify(ids)];
  const n = Number(sql(`UPDATE pj_notifications SET ${set[action]} WHERE ${where}`).run(...vals, ...params).changes);
  return n;
}

/** Marks the notifications about an issue read (when the person opens it). */
export function readIssueNotifications(ctx: Ctx, issueId: string): void {
  sql("UPDATE pj_notifications SET read_at = ? WHERE user_id = ? AND ws_id = ? AND issue_id = ? AND read_at IS NULL").run(Date.now(), ctx.userId, ctx.wsId, issueId);
}

// --- Saved views ---------------------------------------------------------------

interface ViewRow {
  id: string;
  owner_id: string;
  shared: number;
  team_id: string | null;
  project_id: string | null;
  name: string;
  description: string;
  icon: string | null;
  color: string;
  filters: string;
  display: string;
  created_at: number;
  updated_at: number;
}

const VIEW_COLS = "id, owner_id, shared, team_id, project_id, name, description, icon, color, filters, display, created_at, updated_at";

const toView = (r: ViewRow): SavedView => ({
  id: r.id,
  name: r.name,
  description: r.description,
  icon: r.icon,
  color: r.color,
  shared: r.shared === 1,
  ownerId: r.owner_id,
  teamId: r.team_id,
  projectId: r.project_id,
  filters: cleanFilter(JSON.parse(r.filters)),
  display: cleanDisplay(JSON.parse(r.display)),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function listViews(ctx: Ctx): SavedView[] {
  return (
    sql(`SELECT ${VIEW_COLS} FROM pj_views WHERE ws_id = ? AND (owner_id = ? OR shared = 1) AND (team_id IS NULL OR team_id IN (SELECT value FROM json_each(?))) ORDER BY name COLLATE NOCASE`).all(
      ctx.wsId,
      ctx.userId,
      JSON.stringify([...ctx.teams()])
    ) as unknown as ViewRow[]
  ).map(toView);
}

function viewRow(ctx: Ctx, id: string): ViewRow {
  const r = sql(`SELECT ${VIEW_COLS} FROM pj_views WHERE id = ? AND ws_id = ?`).get(id, ctx.wsId) as ViewRow | undefined;
  if (!r || (r.owner_id !== ctx.userId && !r.shared) || (r.team_id && !ctx.teams().has(r.team_id))) throw notFound("view not found");
  return r;
}

export interface ViewInput {
  name?: unknown;
  description?: unknown;
  icon?: unknown;
  color?: unknown;
  shared?: unknown;
  teamId?: unknown;
  projectId?: unknown;
  filters?: unknown;
  display?: unknown;
}

/** Anyone may keep personal views; sharing a view with the workspace takes an editor. */
export function saveView(ctx: Ctx, id: string | null, input: ViewInput): SavedView {
  const cur = id ? viewRow(ctx, id) : null;
  if (cur && cur.owner_id !== ctx.userId) needs(ctx, "edit");
  const shared = input.shared === undefined ? cur?.shared === 1 : input.shared === true;
  if (shared) needs(ctx, "edit");
  const name = input.name === undefined && cur ? cur.name : str(input.name, 80);
  const teamId = input.teamId === undefined ? (cur?.team_id ?? null) : input.teamId === null ? null : String(input.teamId);
  if (teamId && !ctx.teams().has(teamId)) throw notFound("team not found");
  const projectId = input.projectId === undefined ? (cur?.project_id ?? null) : input.projectId === null ? null : String(input.projectId);
  if (projectId && !visibleProject(ctx, projectId)) throw notFound("project not found");
  if (input.color !== undefined && (typeof input.color !== "string" || !COLOR_RE.test(input.color))) throw bad("bad color");
  if (input.icon !== undefined && input.icon !== null && (typeof input.icon !== "string" || [...input.icon].length > 4 || /[<>"'&]/.test(input.icon))) throw bad("bad icon");
  const filters = JSON.stringify(input.filters === undefined ? JSON.parse(cur?.filters ?? "{}") : cleanFilter(input.filters));
  const display = JSON.stringify(input.display === undefined ? JSON.parse(cur?.display ?? "{}") : cleanDisplay(input.display));
  const now = Date.now();
  const vid = id ?? pid();
  if (cur) {
    sql("UPDATE pj_views SET name = ?, description = ?, icon = ?, color = ?, shared = ?, team_id = ?, project_id = ?, filters = ?, display = ?, updated_at = ? WHERE id = ?").run(
      name,
      input.description === undefined ? cur.description : str(input.description, 500, { allowEmpty: true }),
      input.icon === undefined ? cur.icon : ((input.icon as string | null) ?? null),
      input.color === undefined ? cur.color : (input.color as string),
      shared ? 1 : 0,
      teamId,
      projectId,
      filters,
      display,
      now,
      vid
    );
  } else {
    const n = sql("SELECT COUNT(*) AS n FROM pj_views WHERE ws_id = ? AND owner_id = ?").get(ctx.wsId, ctx.userId) as { n: number };
    if (Number(n.n) >= 200) throw new PjError(409, "too many views");
    sql("INSERT INTO pj_views (id, ws_id, owner_id, shared, team_id, project_id, name, description, icon, color, filters, display, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      vid,
      ctx.wsId,
      ctx.userId,
      shared ? 1 : 0,
      teamId,
      projectId,
      name,
      typeof input.description === "string" ? input.description.slice(0, 500) : "",
      (input.icon as string | null | undefined) ?? null,
      (input.color as string | undefined) ?? "#5e6ad2",
      filters,
      display,
      now,
      now
    );
  }
  bump(ctx.wsId);
  emit(ctx, "view", vid);
  return toView(viewRow(ctx, vid));
}

export function deleteView(ctx: Ctx, id: string): void {
  const cur = viewRow(ctx, id);
  if (cur.owner_id !== ctx.userId) needs(ctx, "manage");
  tx(() => {
    sql("DELETE FROM pj_views WHERE id = ?").run(id);
    sql("DELETE FROM pj_favorites WHERE kind = 'view' AND target_id = ?").run(id);
    bump(ctx.wsId);
  });
  emit(ctx, "view", id, { deleted: true });
}

// --- Favorites -----------------------------------------------------------------

export function favorites(ctx: Ctx): Favorite[] {
  const rows = (sql("SELECT kind, target_id, sort_order FROM pj_favorites WHERE user_id = ? AND ws_id = ? ORDER BY sort_order, created_at").all(ctx.userId, ctx.wsId) as {
    kind: Favorite["kind"];
    target_id: string;
    sort_order: number;
  }[]).map((r): Favorite => ({ kind: r.kind, targetId: r.target_id, sortOrder: r.sort_order }));
  const refs = issueRefs(ctx, rows.filter((r) => r.kind === "issue").map((r) => r.targetId));
  // Favorite issues the person can no longer see are left out.
  return rows.filter((r) => r.kind !== "issue" || refs.has(r.targetId)).map((r) => (r.kind === "issue" ? { ...r, identifier: refs.get(r.targetId)?.identifier, title: refs.get(r.targetId)?.title } : r));
}

export function setFavorite(ctx: Ctx, kind: unknown, targetId: unknown, on: boolean): Favorite[] {
  if (!["issue", "project", "view", "cycle", "team"].includes(String(kind)) || typeof targetId !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(targetId)) throw bad("bad favorite");
  if (on) {
    // Only things the person can see (no probing for ids of hidden ones).
    const k = kind as Favorite["kind"];
    const ok =
      k === "issue"
        ? Boolean(visibleIssue(ctx, targetId))
        : k === "project"
          ? visibleProject(ctx, targetId)
          : k === "team"
            ? ctx.teams().has(targetId)
            : k === "cycle"
              ? ctx.teams().has((sql("SELECT team_id FROM pj_cycles WHERE id = ? AND ws_id = ?").get(targetId, ctx.wsId) as { team_id: string } | undefined)?.team_id ?? "")
              : Boolean(sql("SELECT 1 FROM pj_views WHERE id = ? AND ws_id = ? AND (owner_id = ? OR shared = 1)").get(targetId, ctx.wsId, ctx.userId));
    if (!ok) throw notFound();
    const n = sql("SELECT COUNT(*) AS n, IFNULL(MAX(sort_order), 0) AS m FROM pj_favorites WHERE user_id = ? AND ws_id = ?").get(ctx.userId, ctx.wsId) as { n: number; m: number };
    if (Number(n.n) >= 100) throw new PjError(409, "too many favorites");
    sql("INSERT OR IGNORE INTO pj_favorites (ws_id, user_id, kind, target_id, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(ctx.wsId, ctx.userId, kind as string, targetId, Number(n.m) + 1, Date.now());
  } else {
    sql("DELETE FROM pj_favorites WHERE user_id = ? AND ws_id = ? AND kind = ? AND target_id = ?").run(ctx.userId, ctx.wsId, kind as string, targetId);
  }
  return favorites(ctx);
}

// --- Search --------------------------------------------------------------------

export interface SearchResult {
  issues: { id: string; identifier: string; title: string; statusId: string; teamId: string; snippet: string }[];
  projects: { id: string; name: string; color: string; icon: string | null }[];
  teams: { id: string; key: string; name: string }[];
  labels: { id: string; name: string; color: string }[];
}

/** One box for everything: identifiers, titles and descriptions, projects, teams, labels. */
export function search(ctx: Ctx, q: string, limit = 20): SearchResult {
  const query = q.trim().slice(0, 200);
  const empty: SearchResult = { issues: [], projects: [], teams: [], labels: [] };
  if (!query) return empty;
  const teams = JSON.stringify([...ctx.teams()]);
  const like = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows: { id: string; key: string; number: number; title: string; status_id: string; team_id: string; snippet: string | null; rank: number }[] = [];
  const ident = parseIdentifier(query);
  if (ident) {
    rows.push(
      ...(sql(
        "SELECT i.id, t.key, i.number, i.title, i.status_id, i.team_id, NULL AS snippet, -1000 AS rank FROM pj_issues i JOIN pj_teams t ON t.id = i.team_id WHERE i.ws_id = ? AND t.key = ? AND i.number = ? AND i.team_id IN (SELECT value FROM json_each(?))"
      ).all(ctx.wsId, ident.key, ident.number, teams) as typeof rows)
    );
  }
  const fts = ftsQuery(query);
  if (fts) {
    rows.push(
      ...(sql(
        `SELECT i.id, t.key, i.number, i.title, i.status_id, i.team_id, snippet(pj_issues_fts, 1, '', '', '…', 12) AS snippet, bm25(pj_issues_fts, 10.0, 1.0) AS rank
         FROM pj_issues_fts JOIN pj_issues i ON i.fts_id = pj_issues_fts.rowid JOIN pj_teams t ON t.id = i.team_id
         WHERE pj_issues_fts MATCH ? AND i.ws_id = ? AND i.team_id IN (SELECT value FROM json_each(?)) ORDER BY i.archived_at IS NOT NULL, rank LIMIT ?`
      ).all(fts, ctx.wsId, teams, limit) as typeof rows)
    );
  } else {
    rows.push(
      ...(sql(
        "SELECT i.id, t.key, i.number, i.title, i.status_id, i.team_id, NULL AS snippet, 0 AS rank FROM pj_issues i JOIN pj_teams t ON t.id = i.team_id WHERE i.ws_id = ? AND i.team_id IN (SELECT value FROM json_each(?)) AND i.title LIKE ? ESCAPE '\\' ORDER BY i.updated_at DESC LIMIT ?"
      ).all(ctx.wsId, teams, like, limit) as typeof rows)
    );
  }
  const seen = new Set<string>();
  const issues = rows
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .slice(0, limit)
    .map((r) => ({ id: r.id, identifier: `${r.key}-${r.number}`, title: r.title, statusId: r.status_id, teamId: r.team_id, snippet: r.snippet ? plainText(r.snippet, 160) : "" }));
  const lower = query.toLocaleLowerCase();
  const projects = listProjects(ctx)
    .filter((p) => p.name.toLocaleLowerCase().includes(lower) || p.summary.toLocaleLowerCase().includes(lower))
    .slice(0, 8)
    .map((p) => ({ id: p.id, name: p.name, color: p.color, icon: p.icon }));
  const teamHits = listTeams(ctx)
    .filter((t) => t.name.toLocaleLowerCase().includes(lower) || t.key.toLocaleLowerCase() === lower)
    .slice(0, 5)
    .map((t) => ({ id: t.id, key: t.key, name: t.name }));
  const labels = listLabels(ctx)
    .filter((l) => !l.isGroup && l.name.toLocaleLowerCase().includes(lower))
    .slice(0, 8)
    .map((l) => ({ id: l.id, name: l.name, color: l.color }));
  return { issues, projects, teams: teamHits, labels };
}

// --- Bootstrap -----------------------------------------------------------------

export function bootstrap(ctx: Ctx, opts: { personalName: string; today?: string }): Bootstrap {
  const ws = workspaceFor(ctx.userId, ctx.wsId);
  if (!ws) throw notFound();
  const me = sql("SELECT name FROM users WHERE id = ?").get(ctx.userId) as { name: string };
  return {
    ws: { id: ws.id, name: ws.personal ? opts.personalName : ws.name, role: ws.role, personal: ws.personal },
    me: { id: ctx.userId, name: me.name },
    people: people(ctx),
    teams: listTeams(ctx),
    statuses: listStatuses(ctx),
    labels: listLabels(ctx),
    projects: listProjects(ctx),
    cycles: listCycles(ctx),
    views: listViews(ctx),
    fields: listFields(ctx),
    favorites: favorites(ctx),
    unread: unreadCount(ctx),
    seq: changeSeq(ctx.wsId),
    today: opts.today && isDate(opts.today) ? opts.today : dayOf(Date.now()),
  };
}

