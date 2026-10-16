// Server-only: the signed-in person as the apps see them — their workspaces
// and the one that is open (asked for, else the last used, else personal).

import type { AuthUser } from "./auth";
import { guestSpacesOf } from "./notes/access";
import { personalWorkspace, workspaceFor, workspaceOfTeam, workspacesOf, type Workspace } from "./workspaces";
import { exportAllowed } from "./enterprise/security";

export const WS_COOKIE = "zv_ws";

export interface SessionWorkspace {
  id: string;
  name: string;
  /** "guest": not a member, pages shared with the person only (lib/notes/access.ts). */
  role: Workspace["role"] | "guest";
  personal: boolean;
  /** The workspace's security settings turn page export off for this person (lib/enterprise/security.ts). */
  noExport?: true;
}

export interface SessionUser {
  id: string;
  name: string;
  email?: string;
  isAdmin: boolean;
  consentOk: boolean;
  ws: SessionWorkspace;
  workspaces: SessionWorkspace[];
}

const brief = (w: Workspace, personalName: string): SessionWorkspace => ({ id: w.id, name: w.personal ? personalName : w.name, role: w.role, personal: w.personal });

/**
 * `want`: a workspace id from the URL; `last`: the one in the cookie. A
 * workspace the person is not a member of is ignored (never an error page
 * that would confirm it exists).
 */
export function sessionUser(user: AuthUser, want: string | null | undefined, last: string | null | undefined, personalName: string, team?: string | null): SessionUser {
  personalWorkspace(user.id, personalName);
  // Links from Design name its team (?team=<Penpot team id>).
  want = workspaceOfTeam(user.id, team) ?? want;
  const all = workspacesOf(user.id);
  const pick = (id: string | null | undefined) => (id ? all.find((w) => w.id === id) : undefined);
  // Workspaces where the person is a guest (pages shared with them) open only when asked for by link.
  const guestOf = guestSpacesOf(user.id).map((g): SessionWorkspace => ({ id: g.id, name: g.name, role: "guest", personal: false }));
  const asked = want ? guestOf.find((g) => g.id === want) : undefined;
  const ws = pick(want) ?? asked ?? pick(last) ?? (all.find((w) => w.personal) as Workspace);
  return {
    id: user.id,
    name: user.name,
    ...(user.email ? { email: user.email } : {}),
    isAdmin: user.isAdmin,
    consentOk: user.consentOk,
    ws: withPolicy(ws === asked ? asked : brief(ws as Workspace, personalName), user.id),
    workspaces: [...all.map((w) => brief(w, personalName)), ...guestOf],
  };
}

/** The current workspace with what its security settings deny this person. */
function withPolicy(ws: SessionWorkspace, userId: string): SessionWorkspace {
  return exportAllowed(ws.id, userId) ? ws : { ...ws, noExport: true };
}

export function wsCookie(id: string, secure: boolean): string {
  return `${WS_COOKIE}=${encodeURIComponent(id)}; Path=/; SameSite=Lax${secure ? "; Secure" : ""}; Max-Age=${400 * 86400}`;
}

export { workspaceFor };
