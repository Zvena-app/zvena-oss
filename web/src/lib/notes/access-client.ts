// zvena Documents in the browser: what the person may do with a page, for
// the interface only (the server decides; lib/notes/access.ts). Pulled
// notes carry their level (`access`); a note made on this device and not
// pulled back yet goes by its parent, or at the top by its section.

import type { AccessLevel, Note } from "./types";

const RANK: Record<AccessLevel, number> = { full: 4, edit: 3, comment: 2, view: 1 };

export const atLeastLevel = (level: AccessLevel | null | undefined, need: AccessLevel): boolean => Boolean(level && RANK[level] >= RANK[need]);

export type ViewerRole = "owner" | "editor" | "commenter" | "viewer" | "guest";

export function roleToLevel(role: ViewerRole | null | undefined): AccessLevel | null {
  return role === "owner" ? "full" : role === "editor" ? "edit" : role === "commenter" ? "comment" : role === "viewer" ? "view" : null;
}

/** The level of the signed-in person (`me`, their workspace role); a guest device without an account: full (its own pages). */
export function levelIn(id: string, byId: ReadonlyMap<string, Note>, me: { id: string; role: ViewerRole } | null): AccessLevel | null {
  if (!me) return "full";
  let cur = byId.get(id);
  for (let depth = 0; cur && depth < 200; depth++) {
    if (cur.access) return cur.access.level;
    if (!cur.parentId) return spaceLevel(cur.space, me);
    const parent = byId.get(cur.parentId);
    // Its parent is not here: a page this device just made under a page it cannot see, or one in flight.
    if (!parent) return roleToLevel(me.role);
    cur = parent;
  }
  return null;
}

function spaceLevel(space: string | undefined, me: { id: string; role: ViewerRole }): AccessLevel | null {
  if (space === "private" || space === `private:${me.id}`) return "full";
  if (space?.startsWith("private:")) return null;
  return roleToLevel(me.role);
}

/** The sidebar section of a top-level page (or of a page shared on its own). */
export type SidebarSection = { kind: "private" } | { kind: "teamspace"; id: string } | { kind: "workspace" } | { kind: "shared" };

export function sectionOf(n: Note, byId: ReadonlyMap<string, Note>, me: { id: string } | null): SidebarSection | null {
  if (n.access?.shared) return { kind: "shared" };
  if (n.parentId) return byId.has(n.parentId) ? null : { kind: "shared" };
  const s = n.space;
  if (!me) return { kind: "private" };
  if (s === "private" || s === `private:${me.id}`) return { kind: "private" };
  if (s?.startsWith("private:")) return { kind: "shared" };
  if (s?.startsWith("ts:")) return { kind: "teamspace", id: s.slice(3) };
  return { kind: "workspace" };
}
