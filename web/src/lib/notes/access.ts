// Server-only: who may do what with a workspace's documents — Notion's
// access model, enforced here for every read (sync pull) and write (sync
// push, sharing APIs). Devices only display what the server decides.
//
// Levels: full (edit + share), edit, comment, view. A person's level on a
// page is found by walking up the page tree from that page:
//   1. an explicit grant to the person on the page wins (the nearest one:
//      a grant on a sub-page can raise or lower what the parent gives);
//   2. a page whose general access is "Only people invited" (note_access)
//      stops the walk: nobody else gets in (the workspace owner keeps full);
//   3. at the top-level page, its section decides:
//        Private ("private:<user>") — that person only (full);
//        a teamspace ("ts:<id>")    — its members by their workspace role,
//                                     the teamspace owner full; non-members
//                                     view an open teamspace, nothing else;
//        no section                 — the workspace's shared pages: every
//                                     member by role (owner full, editor
//                                     edit, commenter comment, viewer view).
// Guests (people outside the workspace) have no role: grants only.
// Groups (lib/notes/groups.ts): a grant to a group counts for each of its
// members, and a group placed in a teamspace makes its members members
// there; a person's grant on a page is the best of their own and their
// groups' grants on that same page.
// A page whose parent is missing on the server (pushed before it, or cut
// off by edits on two devices) is visible to its creator and the owner only.

import { sql, tx } from "../store";
import { roleIn, type Role } from "../workspaces";
import { nextStamp } from "./stamp";
import type { AccessLevel, NoteAccessInfo } from "./types";
import { accessChanged } from "./access-events";

const RANK: Record<AccessLevel, number> = { full: 4, edit: 3, comment: 2, view: 1 };

export const atLeast = (level: AccessLevel | null | undefined, need: AccessLevel): boolean => Boolean(level && RANK[level] >= RANK[need]);

export const isLevel = (v: unknown): v is AccessLevel => v === "full" || v === "edit" || v === "comment" || v === "view";

export function roleLevel(role: Role | null): AccessLevel | null {
  return role === "owner" ? "full" : role === "editor" ? "edit" : role === "commenter" ? "comment" : role === "viewer" ? "view" : null;
}

const lower = (a: AccessLevel | null, b: AccessLevel | null): AccessLevel | null => (!a || !b ? null : RANK[a] <= RANK[b] ? a : b);

interface NodeRow {
  parent: string | null;
  space: string | null;
  createdBy: string | null;
  deleted: boolean;
}

interface TeamspaceRow {
  privacy: "open" | "closed" | "private";
  /** The person's teamspace role, if a member. */
  mine: "owner" | "member" | null;
}

/** A person's view of one workspace (who they are there), for any number of checks. */
export class AccessResolver {
  readonly role: Role | null;
  readonly isOwner: boolean;
  /** The groups the person is in (workspace members only). */
  readonly groups: ReadonlySet<string>;
  private grants = new Map<string, AccessLevel>();
  private restricted = new Set<string>();
  private teamspaces = new Map<string, TeamspaceRow>();
  private nodes = new Map<string, NodeRow | null>();
  private levels = new Map<string, AccessLevel | null>();

  constructor(
    readonly ws: string,
    readonly userId: string
  ) {
    this.role = roleIn(userId, ws);
    this.isOwner = this.role === "owner";
    for (const g of sql("SELECT note_id, level FROM note_grants WHERE ws = ? AND user_id = ?").all(ws, userId) as { note_id: string; level: AccessLevel }[]) this.grants.set(g.note_id, g.level);
    this.groups = new Set(
      this.role
        ? (sql("SELECT m.group_id FROM ws_group_members m JOIN ws_groups g ON g.id = m.group_id WHERE g.ws = ? AND m.user_id = ?").all(ws, userId) as { group_id: string }[]).map((r) => r.group_id)
        : []
    );
    if (this.groups.size) {
      // The best of the person's own grant and their groups' grants on the same page.
      for (const g of sql("SELECT gg.note_id, gg.level FROM note_group_grants gg JOIN ws_group_members m ON m.group_id = gg.group_id WHERE gg.ws = ? AND m.user_id = ?").all(ws, userId) as {
        note_id: string;
        level: AccessLevel;
      }[]) {
        const cur = this.grants.get(g.note_id);
        if (!cur || RANK[g.level] > RANK[cur]) this.grants.set(g.note_id, g.level);
      }
    }
    for (const r of sql("SELECT note_id FROM note_access WHERE ws = ? AND restricted = 1").all(ws) as { note_id: string }[]) this.restricted.add(r.note_id);
    for (const t of sql("SELECT t.id, t.privacy, m.role FROM teamspaces t LEFT JOIN teamspace_members m ON m.ts_id = t.id AND m.user_id = ? WHERE t.ws = ?").all(userId, ws) as {
      id: string;
      privacy: TeamspaceRow["privacy"];
      role: "owner" | "member" | null;
    }[])
      this.teamspaces.set(t.id, { privacy: t.privacy, mine: t.role ?? null });
    if (this.groups.size) {
      // A group placed in a teamspace makes its members members there.
      for (const r of sql("SELECT tg.ts_id FROM teamspace_groups tg JOIN ws_group_members m ON m.group_id = tg.group_id WHERE m.user_id = ?").all(userId) as { ts_id: string }[]) {
        const ts = this.teamspaces.get(r.ts_id);
        if (ts && !ts.mine) ts.mine = "member";
      }
    }
  }

  /** Whether the person is in the workspace at all (a member, or a guest with a grant). */
  get present(): boolean {
    return this.role !== null || this.grants.size > 0;
  }

  private node(id: string): NodeRow | null {
    if (this.nodes.has(id)) return this.nodes.get(id) ?? null;
    const r = sql("SELECT parent_id, space, deleted, json_extract(json, '$.createdBy') AS created_by FROM notes WHERE ws = ? AND id = ?").get(this.ws, id) as
      | { parent_id: string | null; space: string | null; deleted: number; created_by: string | null }
      | undefined;
    const n = r ? { parent: r.parent_id, space: r.space, createdBy: r.created_by, deleted: r.deleted === 1 } : null;
    this.nodes.set(id, n);
    return n;
  }

  /** What a top-level page's section gives. */
  spaceLevel(space: string | null | undefined): AccessLevel | null {
    if (space?.startsWith("private:")) return space.slice(8) === this.userId ? "full" : null;
    if (space?.startsWith("ts:")) {
      const ts = this.teamspaces.get(space.slice(3));
      // A teamspace that is gone leaves its pages to the workspace.
      if (ts) {
        if (this.isOwner || ts.mine === "owner") return "full";
        if (ts.mine === "member") return roleLevel(this.role);
        return ts.privacy === "open" ? lower(roleLevel(this.role), "view") : null;
      }
    }
    return roleLevel(this.role);
  }

  /** Whether the note is on the server and not deleted. */
  live(id: string): boolean {
    const n = this.node(id);
    return Boolean(n && !n.deleted);
  }

  /** The person's level on a note (null: they may not even see it). */
  level(id: string): AccessLevel | null {
    if (this.levels.has(id)) return this.levels.get(id) ?? null;
    const path: string[] = [];
    let out: AccessLevel | null = null;
    let cur: string | null = id;
    for (let depth = 0; cur && depth < 200; depth++) {
      if (this.levels.has(cur)) {
        out = this.levels.get(cur) ?? null;
        break;
      }
      const n = this.node(cur);
      if (!n) {
        // The parent is not on the server: only the child's creator (and the owner) see it.
        // (The missing one is not cached: the answer depends on which child asks.)
        const child = path.length ? this.node(path[path.length - 1]) : null;
        out = this.isOwner ? "full" : child?.createdBy && child.createdBy === this.userId ? roleLevel(this.role) : null;
        break;
      }
      path.push(cur);
      const grant = this.grants.get(cur);
      if (grant) {
        out = grant;
        break;
      }
      if (this.restricted.has(cur)) {
        out = this.isOwner ? "full" : null;
        break;
      }
      if (n.parent === null) {
        out = this.spaceLevel(n.space);
        break;
      }
      if (path.includes(n.parent)) {
        // A cycle (moves on two devices): the workspace's shared pages.
        out = roleLevel(this.role);
        break;
      }
      cur = n.parent;
    }
    // Everything on the walked path below the answer shares it (no grant or restriction in between).
    for (const p of path) this.levels.set(p, out);
    return out;
  }

  /** The level and flags a pull hands the person with the note. */
  info(id: string): NoteAccessInfo | null {
    const level = this.level(id);
    if (!level) return null;
    const n = this.node(id);
    const restricted = this.restricted.has(id);
    let shared = false;
    if (n?.parent) shared = this.level(n.parent) === null;
    else if (n?.space?.startsWith("private:")) shared = n.space.slice(8) !== this.userId;
    return { level, ...(restricted ? { restricted: true } : {}), ...(shared ? { shared: true } : {}) };
  }

  /** The section of the top-level page above a note (or its own): "private:<user>", "ts:<id>", "" for the workspace's pages. */
  rootSpace(id: string): string {
    const seen = new Set<string>();
    let cur: string | null = id;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const n = this.node(cur);
      if (!n) return "";
      if (n.parent === null) return n.space ?? "";
      cur = n.parent;
    }
    return "";
  }

  /** What the person may do when creating a note under `parentId` (or at the top level in `space`). */
  levelForNew(parentId: string | null, space: string | undefined): AccessLevel | null {
    if (parentId) {
      if (this.node(parentId)) return this.level(parentId);
      // A parent not pushed yet: members who can create pages; the note stays creator-only until it arrives.
      return atLeast(roleLevel(this.role), "edit") ? "edit" : null;
    }
    if (space?.startsWith("private:")) return space.slice(8) === this.userId && atLeast(roleLevel(this.role), "edit") ? "full" : null;
    if (space?.startsWith("ts:")) {
      const ts = this.teamspaces.get(space.slice(3));
      if (!ts) return null;
      if (this.isOwner || ts.mine === "owner") return "full";
      return ts.mine === "member" ? roleLevel(this.role) : null;
    }
    return roleLevel(this.role);
  }
}

/** One check (routes use a resolver for many). */
export function levelOf(ws: string, userId: string, noteId: string): AccessLevel | null {
  return new AccessResolver(ws, userId).level(noteId);
}

/** A person's level on a page for a route (members and guests alike); null: no access, not a member or guest, or a bad workspace id. */
export function pageLevel(userId: string, ws: string | null, noteId: string): AccessLevel | null {
  if (!ws || !docsPresence(userId, ws)) return null;
  return levelOf(ws, userId, noteId);
}

export function canRead(ws: string, userId: string, noteId: string): boolean {
  return levelOf(ws, userId, noteId) !== null;
}

/** "member" (with a role), "guest" (grants only) or null: who may open the workspace's Documents at all. */
export function docsPresence(userId: string, ws: string | null): { role: Role | null; guest: boolean } | null {
  if (!ws || !/^[A-Za-z0-9_-]{8,40}$/.test(ws)) return null;
  const role = roleIn(userId, ws);
  if (role) return { role, guest: false };
  const g = sql("SELECT 1 FROM note_grants WHERE ws = ? AND user_id = ? LIMIT 1").get(ws, userId);
  return g ? { role: null, guest: true } : null;
}

/** Whether the person may edit anything in the workspace (uploads need it): an editing role, or an edit share. */
export function canEditSomewhere(ws: string, userId: string): boolean {
  const p = docsPresence(userId, ws);
  if (!p) return false;
  if (atLeast(roleLevel(p.role), "edit")) return true;
  return Boolean(sql("SELECT 1 FROM note_grants WHERE ws = ? AND user_id = ? AND level IN ('full', 'edit') LIMIT 1").get(ws, userId));
}

/**
 * The people a guest may see named: those who created, edited or were given
 * access to the pages the guest can read — never the workspace's member list.
 */
export function peopleSeenByGuest(ws: string, userId: string): string[] {
  const res = new AccessResolver(ws, userId);
  const out = new Set<string>([userId]);
  const rows = sql("SELECT id, json_extract(json, '$.createdBy') AS cb, json_extract(json, '$.editedBy') AS eb FROM notes WHERE ws = ? AND deleted = 0").all(ws) as {
    id: string;
    cb: string | null;
    eb: string | null;
  }[];
  for (const r of rows) {
    if (res.level(r.id) === null) continue;
    for (const u of [r.cb, r.eb]) if (u && /^[A-Za-z0-9_-]{6,64}$/.test(u)) out.add(u);
    for (const g of sql("SELECT user_id FROM note_grants WHERE ws = ? AND note_id = ?").all(ws, r.id) as { user_id: string }[]) out.add(g.user_id);
  }
  return [...out];
}

/** Workspaces where the person is a guest (grants, no membership): id and name. */
export function guestSpacesOf(userId: string): { id: string; name: string }[] {
  return sql(
    "SELECT DISTINCT w.id, w.name FROM note_grants g JOIN workspaces w ON w.id = g.ws WHERE g.user_id = ? AND NOT EXISTS (SELECT 1 FROM members m WHERE m.ws_id = g.ws AND m.user_id = g.user_id) ORDER BY w.name"
  ).all(userId) as { id: string; name: string }[];
}

/** A note and everything below it (rows of databases included). */
export function subtreeOf(ws: string, rootIds: readonly string[]): string[] {
  const out = new Set<string>();
  for (const root of rootIds) {
    const rows = sql(
      "WITH RECURSIVE sub(id) AS (SELECT ? UNION SELECT n.id FROM notes n JOIN sub ON n.parent_id = sub.id WHERE n.ws = ?) SELECT id FROM sub LIMIT 100000"
    ).all(root, ws) as { id: string }[];
    for (const r of rows) out.add(r.id);
  }
  return [...out];
}

/**
 * What decides who reads a page placed under `parentId`: the nearest page
 * above it that is restricted or shared with someone (people or groups), or
 * else its section. Two places with the same anchor are read by the same
 * people; a move between different ones needs full access.
 */
export function accessAnchor(ws: string, parentId: string | null, space: string): string {
  let cur = parentId;
  for (let depth = 0; cur && depth < 200; depth++) {
    const shared = sql(
      "SELECT 1 FROM note_access WHERE ws = ? AND note_id = ? AND restricted = 1 UNION ALL SELECT 1 FROM note_grants WHERE ws = ? AND note_id = ? UNION ALL SELECT 1 FROM note_group_grants WHERE ws = ? AND note_id = ? LIMIT 1"
    ).get(ws, cur, ws, cur, ws, cur);
    if (shared) return `note:${cur}`;
    const up = sql("SELECT parent_id FROM notes WHERE ws = ? AND id = ?").get(ws, cur) as { parent_id: string | null } | undefined;
    cur = up?.parent_id ?? null;
  }
  return `space:${space}`;
}

/** Everyone who may have access to something in the workspace: members and guests. */
export function principals(ws: string): string[] {
  const rows = sql("SELECT user_id FROM members WHERE ws_id = ? UNION SELECT user_id FROM note_grants WHERE ws = ?").all(ws, ws) as { user_id: string }[];
  return rows.map((r) => r.user_id);
}

/** For each person, the notes among `ids` they may read. */
export function readableSets(ws: string, people: readonly string[], ids: readonly string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const u of people) {
    const r = new AccessResolver(ws, u);
    out.set(u, new Set(ids.filter((id) => r.level(id) !== null)));
  }
  return out;
}

/**
 * After access to `ids` changed (`before`: who could read what): people who
 * lost a note get a revocation (their devices drop it), people who can read
 * it again lose theirs, and the notes are stamped anew so every device
 * pulls them with the new levels.
 */
export function settleAccess(ws: string, ids: readonly string[], before: Map<string, Set<string>>, skip: ReadonlySet<string> = new Set()): void {
  if (ids.length === 0) return;
  const people = [...new Set([...before.keys(), ...principals(ws)])];
  const after = readableSets(ws, people, ids);
  for (const u of people) {
    const had = before.get(u) ?? new Set<string>();
    const has = after.get(u) ?? new Set<string>();
    for (const id of had) if (!has.has(id)) sql("INSERT INTO note_revoked (ws, note_id, user_id, stamp) VALUES (?, ?, ?, ?) ON CONFLICT(ws, note_id, user_id) DO UPDATE SET stamp = excluded.stamp").run(ws, id, u, nextStamp());
    for (const id of has) if (!had.has(id)) sql("DELETE FROM note_revoked WHERE ws = ? AND note_id = ? AND user_id = ?").run(ws, id, u);
  }
  for (const id of ids) if (!skip.has(id)) sql("UPDATE notes SET stamp = ? WHERE ws = ? AND id = ?").run(nextStamp(), ws, id);
  // Open live sessions re-check their people (lib/notes/collab.ts).
  accessChanged(ws);
}

/** Runs an access change on the subtrees of `roots` and settles who sees what afterwards (one transaction). */
export function changeAccess<T>(ws: string, roots: readonly string[], change: () => T): T {
  return tx(() => {
    const ids = subtreeOf(ws, roots);
    const before = readableSets(ws, principals(ws), ids);
    const out = change();
    settleAccess(ws, ids, before);
    return out;
  });
}

// ---------------------------------------------------------------------------
// Page access settings (the Share menu)

export interface AccessEntry {
  userId: string;
  level: AccessLevel;
  /** Not a member of the workspace. */
  guest: boolean;
}

export interface PageAccess {
  /** "Only people invited" on this page itself. */
  restricted: boolean;
  /** The page whose setting this page follows, when inherited ("restricted" above it), else null. */
  restrictedFrom: string | null;
  grants: AccessEntry[];
  /** Groups given a level on this page. */
  groups: { groupId: string; name: string; level: AccessLevel; members: number }[];
}

export function pageAccess(ws: string, noteId: string): PageAccess {
  const own = sql("SELECT restricted FROM note_access WHERE ws = ? AND note_id = ?").get(ws, noteId) as { restricted: number } | undefined;
  let restrictedFrom: string | null = null;
  if (!own?.restricted) {
    // The nearest restricted ancestor, if any.
    const seen = new Set<string>([noteId]);
    let cur = (sql("SELECT parent_id FROM notes WHERE ws = ? AND id = ?").get(ws, noteId) as { parent_id: string | null } | undefined)?.parent_id ?? null;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      if ((sql("SELECT restricted FROM note_access WHERE ws = ? AND note_id = ?").get(ws, cur) as { restricted: number } | undefined)?.restricted) {
        restrictedFrom = cur;
        break;
      }
      cur = (sql("SELECT parent_id FROM notes WHERE ws = ? AND id = ?").get(ws, cur) as { parent_id: string | null } | undefined)?.parent_id ?? null;
    }
  }
  const grants = (
    sql(
      "SELECT g.user_id, g.level, (SELECT 1 FROM members m WHERE m.ws_id = g.ws AND m.user_id = g.user_id) AS member FROM note_grants g WHERE g.ws = ? AND g.note_id = ? ORDER BY g.created_at"
    ).all(ws, noteId) as { user_id: string; level: AccessLevel; member: number | null }[]
  ).map((g) => ({ userId: g.user_id, level: g.level, guest: !g.member }));
  const groups = (
    sql(
      "SELECT gg.group_id, gg.level, g.name, (SELECT COUNT(*) FROM ws_group_members m WHERE m.group_id = gg.group_id) AS n FROM note_group_grants gg JOIN ws_groups g ON g.id = gg.group_id WHERE gg.ws = ? AND gg.note_id = ? ORDER BY gg.created_at"
    ).all(ws, noteId) as { group_id: string; level: AccessLevel; name: string; n: number }[]
  ).map((g) => ({ groupId: g.group_id, name: g.name, level: g.level, members: Number(g.n) }));
  return { restricted: Boolean(own?.restricted), restrictedFrom, grants, groups };
}

/** Sets "Only people invited" on a page (the one restricting keeps full access). */
export function setRestricted(ws: string, noteId: string, restricted: boolean, actor: string): void {
  changeAccess(ws, [noteId], () => {
    if (restricted) {
      sql("INSERT INTO note_access (ws, note_id, restricted, changed_by, changed_at) VALUES (?, ?, 1, ?, ?) ON CONFLICT(ws, note_id) DO UPDATE SET restricted = 1, changed_by = excluded.changed_by, changed_at = excluded.changed_at").run(
        ws,
        noteId,
        actor,
        Date.now()
      );
      if (roleIn(actor, ws) !== "owner") grantRow(ws, noteId, actor, "full", actor);
    } else sql("DELETE FROM note_access WHERE ws = ? AND note_id = ?").run(ws, noteId);
  });
}

function grantRow(ws: string, noteId: string, userId: string, level: AccessLevel, by: string): void {
  sql(
    "INSERT INTO note_grants (ws, note_id, user_id, level, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(ws, note_id, user_id) DO UPDATE SET level = excluded.level, granted_by = excluded.granted_by"
  ).run(ws, noteId, userId, level, by, Date.now());
}

export function grant(ws: string, noteId: string, userId: string, level: AccessLevel, by: string): void {
  changeAccess(ws, [noteId], () => grantRow(ws, noteId, userId, level, by));
}

/** Gives a group a level on a page and its subtree (the group's members get it). */
export function grantGroup(ws: string, noteId: string, groupId: string, level: AccessLevel, by: string): void {
  changeAccess(ws, [noteId], () => {
    sql(
      "INSERT INTO note_group_grants (ws, note_id, group_id, level, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(ws, note_id, group_id) DO UPDATE SET level = excluded.level, granted_by = excluded.granted_by"
    ).run(ws, noteId, groupId, level, by, Date.now());
  });
}

export function revokeGroup(ws: string, noteId: string, groupId: string): boolean {
  return changeAccess(ws, [noteId], () => Number(sql("DELETE FROM note_group_grants WHERE ws = ? AND note_id = ? AND group_id = ?").run(ws, noteId, groupId).changes) > 0);
}

export function revoke(ws: string, noteId: string, userId: string): boolean {
  return changeAccess(ws, [noteId], () => Number(sql("DELETE FROM note_grants WHERE ws = ? AND note_id = ? AND user_id = ?").run(ws, noteId, userId).changes) > 0);
}

/** Notes the person can no longer read since `since` (and up to `until`). */
export function revokedSince(ws: string, userId: string, since: number, until: number): string[] {
  return (sql("SELECT note_id FROM note_revoked WHERE ws = ? AND user_id = ? AND stamp > ? AND stamp <= ?").all(ws, userId, since, until) as { note_id: string }[]).map((r) => r.note_id);
}

/** The newest revocation stamp of the person in the workspace (0: none). */
export function lastRevocation(ws: string, userId: string): number {
  return Number((sql("SELECT COALESCE(MAX(stamp), 0) AS s FROM note_revoked WHERE ws = ? AND user_id = ?").get(ws, userId) as { s: number }).s);
}
