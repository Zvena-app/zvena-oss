// Who may hear about what on the live stream. Server-only.
//
// The pulse sends ids, never content, but even an id tells that private work
// exists and when it moves. Projects' private teams are the one place in the
// ecosystem where members of a workspace do not all see the same things, so
// every "projects" and "links" poke is checked per person before it is sent
// (lib/pulse/bus.ts registerPulseFilter). Calendars are private unless
// shared: "calendar" pokes and event keys follow lib/calendar/access.ts.
// Server listeners (the indexer, reactions) still hear everything.

import { registerPulseFilter, type PulseEvent } from "../pulse/bus";
import { visibleTeamIds } from "../projects/core";
import { sql } from "../store";
import { roleIn } from "../workspaces";
import { AccessResolver } from "../notes/access";
import { accessGeneration } from "../notes/access-events";
import { calendarPulseVisible, eventKeyVisible } from "../calendar/access";
import { threadOwner } from "../mail-client/store";
import { metricReadable } from "../decide/sources";

const TTL = 10_000;
const teamsCache = new Map<string, { at: number; teams: Set<string> | null }>();

/** The teams a person sees in a workspace (null: not a member). Cached for a few seconds: this runs per person per event. */
function teamsOf(userId: string, ws: string): Set<string> | null {
  const k = `${userId}|${ws}`;
  const hit = teamsCache.get(k);
  if (hit && Date.now() - hit.at < TTL) return hit.teams;
  const role = roleIn(userId, ws);
  const teams = role ? new Set(visibleTeamIds(userId, ws, role)) : null;
  teamsCache.set(k, { at: Date.now(), teams });
  if (teamsCache.size > 10_000) teamsCache.clear();
  return teams;
}

function issueTeam(ws: string, id: string): string | null {
  return (sql("SELECT team_id FROM pj_issues WHERE id = ? AND ws_id = ?").get(id, ws) as { team_id: string } | undefined)?.team_id ?? null;
}

function projectTeams(id: string): string[] {
  return (sql("SELECT team_id FROM pj_project_teams WHERE project_id = ?").all(id) as { team_id: string }[]).map((r) => r.team_id);
}

function teamIsPrivate(id: string): boolean {
  return Boolean((sql("SELECT private FROM pj_teams WHERE id = ?").get(id) as { private: number } | undefined)?.private);
}

/** Whether something of a private team is behind this key (it then goes in a poke of its own). */
export function restricted(ws: string, key: string): boolean {
  // Pages and events may be private to some people, a mail conversation is its owner's: each is announced on its own.
  if (key.startsWith("note:") || key.startsWith("event:") || key.startsWith("mail:")) return true;
  if (key.startsWith("issue:")) {
    const team = issueTeam(ws, key.slice(6));
    return team !== null && teamIsPrivate(team);
  }
  if (key.startsWith("project:")) {
    const teams = projectTeams(key.slice(8));
    return teams.length > 0 && teams.every(teamIsPrivate);
  }
  return false;
}

const pageCache = new Map<string, { at: number; gen: number; acc: AccessResolver }>();

/** Documents' page access for a person (a resolver caches what it walks), reused for a few seconds. */
function pagesOf(userId: string, ws: string): AccessResolver {
  const k = `${userId}|${ws}`;
  const hit = pageCache.get(k);
  // Shares, restrictions, moves or members changed since: the cached view no longer stands.
  const gen = accessGeneration(ws);
  if (hit && hit.gen === gen && Date.now() - hit.at < TTL) return hit.acc;
  const acc = new AccessResolver(ws, userId);
  pageCache.set(k, { at: Date.now(), gen, acc });
  if (pageCache.size > 10_000) pageCache.clear();
  return acc;
}

/**
 * May this person know about this key? Private teams' issues and projects:
 * their members only; pages: whoever may read them (Documents' access);
 * events: whoever reads their calendar or is their guest (Calendar's access);
 * mail conversations: their owner only; numbers: typed and pushed ones every member,
 * counted ones whoever may see what they count; designs and people: every member.
 */
export function keyVisible(userId: string, ws: string, key: string): boolean {
  if (key.startsWith("mail:")) return threadOwner(key.slice(5)) === userId;
  if (key.startsWith("metric:")) return metricReadable(ws, key.slice(7), userId);
  if (key.startsWith("note:")) {
    // One cached resolver per person answers role, existence and level (this runs per event per open tab).
    const acc = pagesOf(userId, ws);
    if (!acc.role) return false;
    const id = key.slice(5);
    // A page that no longer exists tells nothing.
    if (!acc.live(id)) return true;
    return acc.level(id) !== null;
  }
  if (key.startsWith("event:")) return Boolean(roleIn(userId, ws)) && eventKeyVisible(userId, ws, key.slice(6));
  if (!key.startsWith("issue:") && !key.startsWith("project:")) return true;
  const teams = teamsOf(userId, ws);
  if (!teams) return false;
  if (key.startsWith("issue:")) {
    const team = issueTeam(ws, key.slice(6));
    return team === null || teams.has(team);
  }
  const ts = projectTeams(key.slice(8));
  return ts.length === 0 || ts.some((t) => teams.has(t));
}

function projectsVisible(userId: string, e: PulseEvent): boolean {
  if (!e.ref) return true;
  const entity = e.data?.entity;
  if (entity === "issue" || entity === "comment" || entity === undefined) return keyVisible(userId, e.ws, `issue:${e.ref}`);
  if (entity === "project") return keyVisible(userId, e.ws, `project:${e.ref}`);
  if (entity === "team") {
    if (!teamIsPrivate(e.ref)) return true;
    return Boolean(teamsOf(userId, e.ws)?.has(e.ref));
  }
  return true;
}

function linksVisible(userId: string, e: PulseEvent): boolean {
  const keys = e.refs ?? (e.ref ? [e.ref] : []);
  return keys.every((k) => keyVisible(userId, e.ws, k));
}

const KEY = Symbol.for("zvena.eco.visibility");
const g = globalThis as unknown as Record<symbol, boolean | undefined>;

/** Once per process (startEco). */
export function registerEcoFilters(): void {
  if (g[KEY]) return;
  g[KEY] = true;
  registerPulseFilter("projects", projectsVisible);
  registerPulseFilter("links", linksVisible);
  registerPulseFilter("calendar", calendarPulseVisible);
  // Mail pokes name their owner (lib/mail-client/events.ts): nobody else hears them.
  registerPulseFilter("mail", (userId, e) => e.ref === userId);
  // An Inbox poke names the person it is for: only they hear it (it would otherwise
  // tell everyone in the workspace when someone got an item — now even new mail).
  registerPulseFilter("inbox", (userId, e) => !e.ref || e.ref === userId);
}
