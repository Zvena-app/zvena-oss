// Zvena Projects, server side: who is asking and what they may do.
//
// Every operation starts from a Ctx: the signed-in person, the workspace named
// by the request, and their role in it (the workspace roles of zvena —
// owner / editor / commenter / viewer — apply here unchanged):
//
//   viewer     reads issues, projects, cycles; keeps personal views and favorites
//   commenter  + comments, reactions, subscriptions
//   editor     + creates and changes issues, projects, cycles, labels, teams, shared views
//   owner      + deletes teams and projects, manages everything
//
// Private teams are visible to their members and to the workspace owner only;
// their issues are invisible elsewhere (lists, search, relations, inbox).
// Objects are always looked up together with ws_id, so an id from another
// workspace is simply "not found".

import { newId, sql } from "../store";
import { changed, type PjChange, type PjEntity } from "./events";
import { can, roleIn, type Role } from "../workspaces";

export class PjError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail?: string
  ) {
    super(code);
  }
}

export const notFound = (what = "not found") => new PjError(404, what);
export const forbidden = () => new PjError(403, "forbidden");
export const bad = (detail = "bad request") => new PjError(400, "bad request", detail);

export type Need = "read" | "comment" | "edit" | "manage";

export interface Ctx {
  userId: string;
  wsId: string;
  role: Role;
  /** Teams this person can see (cached for the request). */
  teams(): Set<string>;
  /** Where the request came from (for event buses that skip echoes); optional. */
  origin?: string;
  /** Acting on the person's behalf: 'jev' — Jev's autopilot (shown in the history). */
  via?: "jev";
  /** Background work that Jev's autopilot must not pick up (the first-run examples). */
  quiet?: boolean;
}

const WS_RE = /^[A-Za-z0-9_-]{8,40}$/;

export function ctxFor(userId: string, wsId: string | null | undefined, need: Need = "read"): Ctx {
  if (!wsId || !WS_RE.test(wsId)) throw forbidden();
  const role = roleIn(userId, wsId);
  if (!role || !can[need](role)) throw forbidden();
  let cache: Set<string> | null = null;
  return {
    userId,
    wsId,
    role,
    teams() {
      if (!cache) cache = new Set(visibleTeamIds(userId, wsId, role));
      return cache;
    },
  };
}

export function needs(ctx: Ctx, need: Need): void {
  if (!can[need](ctx.role)) throw forbidden();
}

export function visibleTeamIds(userId: string, wsId: string, role: Role): string[] {
  return (
    sql(
      `SELECT t.id FROM pj_teams t WHERE t.ws_id = ? AND (t.private = 0 OR ? = 'owner' OR EXISTS (SELECT 1 FROM pj_team_members m WHERE m.team_id = t.id AND m.user_id = ?))`
    ).all(wsId, role, userId) as { id: string }[]
  ).map((r) => r.id);
}

/**
 * A project is visible when it has no teams or at least one team the person
 * sees (a project of private teams only stays hidden from everyone else).
 */
export function visibleProject(ctx: Ctx, projectId: string): boolean {
  const p = sql("SELECT 1 FROM pj_projects WHERE id = ? AND ws_id = ?").get(projectId, ctx.wsId);
  if (!p) return false;
  const teams = (sql("SELECT team_id FROM pj_project_teams WHERE project_id = ?").all(projectId) as { team_id: string }[]).map((x) => x.team_id);
  return teams.length === 0 || teams.some((t) => ctx.teams().has(t));
}

/** An issue id of this workspace in a team the person sees (else null). */
export function visibleIssue(ctx: Ctx, issueId: string): { id: string; team_id: string } | null {
  const r = sql("SELECT id, team_id FROM pj_issues WHERE id = ? AND ws_id = ?").get(issueId, ctx.wsId) as { id: string; team_id: string } | undefined;
  return r && ctx.teams().has(r.team_id) ? r : null;
}

/** JSON array parameter for `IN (SELECT value FROM json_each(?))`. */
export function teamsParam(ctx: Ctx): string {
  return JSON.stringify([...ctx.teams()]);
}

export function assertTeam(ctx: Ctx, teamId: string | null | undefined): string {
  if (!teamId || !ctx.teams().has(teamId)) throw notFound("team not found");
  return teamId;
}

/** Moves the workspace's change counter (open pages refresh when it moves). */
export function bump(wsId: string): number {
  const now = Date.now();
  const r = sql("INSERT INTO pj_changes (ws_id, seq, at) VALUES (?, 1, ?) ON CONFLICT(ws_id) DO UPDATE SET seq = seq + 1, at = excluded.at RETURNING seq").get(wsId, now) as { seq: number };
  return Number(r.seq);
}

export function changeSeq(wsId: string): number {
  const r = sql("SELECT seq FROM pj_changes WHERE ws_id = ?").get(wsId) as { seq: number } | undefined;
  return r ? Number(r.seq) : 0;
}

export const pid = () => newId(12);

/** Announces a committed change (lib/projects/events.ts). */
export function emit(ctx: Ctx, entity: PjEntity, id: string, extra: Pick<PjChange, "issueId" | "deleted" | "created" | "goal"> = {}): void {
  changed({ ws: ctx.wsId, entity, id, by: ctx.userId, ...(ctx.origin ? { origin: ctx.origin } : {}), ...(ctx.via ? { via: ctx.via } : {}), ...(ctx.quiet ? { quiet: true } : {}), ...extra });
}

/** Is `userId` a member of the workspace (assignees, leads, mentions must be)? */
export function isMember(wsId: string, userId: string): boolean {
  return roleIn(userId, wsId) !== null;
}

export function str(v: unknown, max: number, opts: { trim?: boolean; allowEmpty?: boolean } = {}): string {
  if (typeof v !== "string") throw bad("expected text");
  const s = opts.trim === false ? v : v.trim();
  if (!opts.allowEmpty && !s) throw bad("empty text");
  if (s.length > max) throw bad("text too long");
  return s;
}

export function optStr(v: unknown, max: number): string | undefined {
  return v === undefined ? undefined : str(v, max, { allowEmpty: true });
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** Midpoint between two sort orders (null = open end). */
export function between(before: number | null, after: number | null): number {
  if (before === null && after === null) return 0;
  if (before === null) return (after as number) - 1;
  if (after === null) return before + 1;
  return (before + after) / 2;
}
