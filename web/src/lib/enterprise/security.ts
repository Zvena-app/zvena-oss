// Server-only: a workspace's security settings (Notion's Settings →
// Security), set by its owner and enforced by the routes themselves:
//
//   disablePublish    no "Publish to web", no public form links; pages
//                     already published stop being served (kept, not deleted)
//   disableGuests     no page shared with people outside the workspace
//                     (invite links, e-mail invites, grants to non-members)
//   disableExport     the account export leaves the workspace's documents
//                     and issues out (owners excepted)
//   disableMoveOut    no "Move to" another workspace
//   membersCanInvite  editors may invite people too (otherwise owners only)
//   joinRole          the role of people who join through an allowed e-mail domain

import { changeAccess } from "../notes/access";
import { audit, sql } from "../store";
import { roleIn, type Role } from "../workspaces";
import { ensureTables } from "./tables";

export interface SecuritySettings {
  disablePublish: boolean;
  disableGuests: boolean;
  disableExport: boolean;
  disableMoveOut: boolean;
  membersCanInvite: boolean;
  joinRole: Exclude<Role, "owner">;
}

export const DEFAULT_SECURITY: Readonly<SecuritySettings> = Object.freeze({
  disablePublish: false,
  disableGuests: false,
  disableExport: false,
  disableMoveOut: false,
  membersCanInvite: false,
  joinRole: "editor",
});

const FLAGS = ["disablePublish", "disableGuests", "disableExport", "disableMoveOut", "membersCanInvite"] as const;
const JOIN_ROLES = ["editor", "commenter", "viewer"] as const;
const WS_RE = /^[A-Za-z0-9_-]{8,40}$/;

function clean(v: unknown, base: SecuritySettings): SecuritySettings {
  const r = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const out: SecuritySettings = { ...base };
  for (const f of FLAGS) if (typeof r[f] === "boolean") out[f] = r[f] as boolean;
  if ((JOIN_ROLES as readonly unknown[]).includes(r.joinRole)) out.joinRole = r.joinRole as SecuritySettings["joinRole"];
  return out;
}

export function securityOf(ws: string | null | undefined): SecuritySettings {
  if (!ws || !WS_RE.test(ws)) return { ...DEFAULT_SECURITY };
  ensureTables();
  const row = sql("SELECT json FROM ent_ws_settings WHERE ws = ?").get(ws) as { json: string } | undefined;
  if (!row) return { ...DEFAULT_SECURITY };
  try {
    return clean(JSON.parse(row.json), { ...DEFAULT_SECURITY });
  } catch {
    return { ...DEFAULT_SECURITY };
  }
}

/** Applies a partial change (unknown fields ignored); every changed setting is a line in the audit log. */
export function updateSecurity(ws: string, actor: string, patch: unknown): SecuritySettings {
  ensureTables();
  const before = securityOf(ws);
  const next = clean(patch, before);
  sql("INSERT INTO ent_ws_settings (ws, json, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(ws) DO UPDATE SET json = excluded.json, updated_by = excluded.updated_by, updated_at = excluded.updated_at").run(
    ws,
    JSON.stringify(next),
    actor,
    Date.now()
  );
  for (const k of [...FLAGS, "joinRole"] as const) {
    if (before[k] !== next[k]) audit(actor, "security.update", ws, { setting: k, value: next[k] });
  }
  if (next.disableGuests && !before.disableGuests) removeGuests(ws, actor);
  return next;
}

/**
 * Guests off: everyone outside the workspace loses the pages shared with them
 * (their devices drop them on the next sync). Invite links stay for members;
 * no one outside can accept one while guests are off.
 */
function removeGuests(ws: string, actor: string): void {
  const rows = sql("SELECT g.note_id, g.user_id FROM note_grants g WHERE g.ws = ? AND NOT EXISTS (SELECT 1 FROM members m WHERE m.ws_id = g.ws AND m.user_id = g.user_id)").all(ws) as { note_id: string; user_id: string }[];
  const pages = [...new Set(rows.map((r) => r.note_id))];
  if (pages.length) {
    changeAccess(ws, pages, () => {
      for (const r of rows) sql("DELETE FROM note_grants WHERE ws = ? AND note_id = ? AND user_id = ?").run(ws, r.note_id, r.user_id);
    });
  }
  audit(actor, "security.guests.removed", ws, { guests: new Set(rows.map((r) => r.user_id)).size });
}

// --- Checks the routes call ------------------------------------------------------

/** The workspace publishes to the web (Publish, public forms, serving them). */
export const publishingAllowed = (ws: string | null | undefined): boolean => !securityOf(ws).disablePublish;

/** Whether `userId` may be given access as a guest (members always may). */
export function guestAllowed(ws: string, userId: string | null): boolean {
  if (userId && roleIn(userId, ws)) return true;
  return !securityOf(ws).disableGuests;
}

/** Guests are off in the workspace (for routes that only ever add guests, such as page invite links). */
export const guestsDisabled = (ws: string): boolean => securityOf(ws).disableGuests;

/** The workspace's documents may leave in an export by `userId` (owners always). */
export function exportAllowed(ws: string, userId: string): boolean {
  return roleIn(userId, ws) === "owner" || !securityOf(ws).disableExport;
}

export const moveOutAllowed = (ws: string): boolean => !securityOf(ws).disableMoveOut;

/** Who may invite people to the workspace: its owner, and editors when the owner allows it. */
export function canInvite(userId: string, ws: string | null | undefined): boolean {
  if (!ws || !WS_RE.test(ws)) return false;
  const role = roleIn(userId, ws);
  if (role === "owner") return true;
  return role === "editor" && securityOf(ws).membersCanInvite;
}
