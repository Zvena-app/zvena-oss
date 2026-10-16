// Server-only: the bridge to Design (the zvena fork of Penpot).
//
// zvena is the source of truth for accounts, workspaces and roles; Design
// mirrors them. Calls go to the Penpot backend's internal management API
// (zvena/design: backend/src/app/zvena/management.clj), loopback / docker
// network only, authenticated with a shared key (PENPOT_MGMT_KEY). Design
// knows a person by a technical login "u-<id>@users.zvena.app": no real
// e-mail or name beyond the display name is copied into it.
//
// Every call is best effort with a timeout: Design being down never breaks
// Documents, and the next open of Design syncs again.

import type { AuthUser } from "./auth";
import type { Role } from "./workspaces";

const TIMEOUT_MS = 8_000;

export function designConfigured(): boolean {
  return Boolean(process.env.PENPOT_MGMT_URL && process.env.PENPOT_MGMT_KEY);
}

export function designLogin(userId: string): string {
  const domain = (process.env.PENPOT_EMAIL_DOMAIN || "users.zvena.app").trim();
  return `u-${userId}@${domain}`;
}

/** The user id behind a Design login, or null. */
export function userIdOfLogin(email: string): string | null {
  const m = /^u-([0-9a-f]{24})@/.exec(email.trim().toLowerCase());
  return m ? m[1] : null;
}

export class DesignError extends Error {
  constructor(public status: number) {
    super(`design ${status}`);
  }
}

async function call<T>(action: string, body: Record<string, unknown>, timeoutMs = TIMEOUT_MS): Promise<T> {
  if (!designConfigured()) throw new DesignError(0);
  const base = (process.env.PENPOT_MGMT_URL || "").replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/management/zvena/${action}`, {
      method: "POST",
      // Without accept: application/json Penpot answers in Transit.
      headers: { "content-type": "application/json", accept: "application/json", "x-shared-key": process.env.PENPOT_MGMT_KEY || "" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new DesignError(503);
  }
  if (!res.ok) throw new DesignError(res.status);
  return (await res.json()) as T;
}

/** Penpot's roles: a zvena viewer is a Penpot viewer that may not comment. */
function penpotRole(role: Role): string {
  return role;
}

export interface DesignMember {
  email: string;
  fullname: string;
  role: Role;
}

/** Creates the Design profile when missing; returns it and its personal ("Drafts") team. */
export function ensureProfile(user: Pick<AuthUser, "id" | "name">): Promise<{ profileId: string; defaultTeamId: string }> {
  return call("ensure-profile", { email: designLogin(user.id), fullname: user.name });
}

/**
 * Makes the workspace's Penpot team exist with exactly these members and
 * roles (idempotent). Returns the team id to remember.
 */
export function syncTeam(input: { teamId: string | null; name: string; members: DesignMember[] }): Promise<{ teamId: string }> {
  return call("sync-team", {
    teamId: input.teamId,
    name: input.name,
    members: input.members.map((m) => ({ email: m.email, fullname: m.fullname, role: penpotRole(m.role) })),
  });
}

export function deleteTeam(teamId: string): Promise<{ deleted: boolean }> {
  return call("delete-team", { teamId });
}

/** Deletes the profile (teams it shares go to the next member; the rest is purged). */
export function deleteProfile(userId: string): Promise<{ deleted: boolean }> {
  return call("delete-profile", { email: designLogin(userId) });
}

/** Bytes the person's own Design teams store (media, fonts, file data). */
export async function designUsage(userId: string): Promise<number> {
  const r = await call<{ bytes: number }>("usage", { email: designLogin(userId) });
  return Number(r.bytes) || 0;
}

export interface DesignFile {
  id: string;
  name: string;
  project: string;
  modifiedAt: string;
}

/** Files of a team the person can read (newest first) — for the "Insert a design" picker. */
export function teamFiles(userId: string, teamId: string): Promise<{ files: DesignFile[] }> {
  return call("files", { email: designLogin(userId), teamId });
}

export interface DesignFrame {
  id: string;
  name: string;
  pageId: string;
  pageName: string;
  width: number;
  height: number;
}

export function fileFrames(userId: string, fileId: string): Promise<{ name: string; teamId: string; revn: number; frames: DesignFrame[] }> {
  return call("frames", { email: designLogin(userId), fileId });
}

export interface FramePreview {
  name: string;
  revn: number;
  teamId: string;
  pageId: string;
  width: number;
  height: number;
  /** Storage object of the frame thumbnail (null: not rendered yet — open the design once). */
  mediaId: string | null;
  mediaType: string | null;
}

/** A frame's current thumbnail, if the person may read the file. */
export function framePreview(userId: string, fileId: string, frameId: string): Promise<FramePreview> {
  return call("frame-preview", { email: designLogin(userId), fileId, frameId });
}

/** The frame thumbnail's bytes (null: none rendered yet, or no access). */
export async function frameImage(userId: string, fileId: string, frameId: string): Promise<{ bytes: ArrayBuffer; type: string } | null> {
  if (!designConfigured()) return null;
  const base = (process.env.PENPOT_MGMT_URL || "").replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/management/zvena/frame-image`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shared-key": process.env.PENPOT_MGMT_KEY || "" },
      body: JSON.stringify({ email: designLogin(userId), fileId, frameId }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return { bytes: await res.arrayBuffer(), type: res.headers.get("content-type") || "image/png" };
  } catch {
    return null;
  }
}

/** Every Design file the person owns or edits (for the data export). */
export function exportList(userId: string): Promise<{ files: (DesignFile & { team: string })[] }> {
  return call("export-list", { email: designLogin(userId) });
}

/** One file as a .penpot archive (Penpot's own format, importable back). */
export async function exportFile(userId: string, fileId: string): Promise<ArrayBuffer | null> {
  if (!designConfigured()) return null;
  const base = (process.env.PENPOT_MGMT_URL || "").replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/management/zvena/export-file`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shared-key": process.env.PENPOT_MGMT_KEY || "" },
      body: JSON.stringify({ email: designLogin(userId), fileId }),
      signal: AbortSignal.timeout(120_000),
    });
    return res.ok ? await res.arrayBuffer() : null;
  } catch {
    return null;
  }
}

/** A new empty design file in the team's default project; returns its id. */
export function createFile(userId: string, teamId: string, name: string): Promise<{ fileId: string; projectId: string }> {
  return call("create-file", { email: designLogin(userId), teamId, name });
}

/** Imports a .penpot file (a design template) into the team; returns the new file. */
export function importTemplate(userId: string, teamId: string, name: string, data: Buffer): Promise<{ fileId: string; projectId: string }> {
  return call("import-template", { email: designLogin(userId), teamId, name, data: data.toString("base64") }, 120_000);
}

/** Takes a published design link down after a complaint. */
export function unpublish(shareId: string): Promise<{ removed: boolean }> {
  return call("unpublish", { shareId });
}
