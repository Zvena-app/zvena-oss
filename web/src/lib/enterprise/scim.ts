// Server-only: SCIM 2.0 provisioning (RFC 7643 / 7644) for a workspace, at
// /scim/v2 — what Okta, Microsoft Entra ID, OneLogin and the like call to
// keep a workspace's people in step with the company directory.
//
//   Users    a workspace member. POST creates (or finds, by e-mail) the
//            account and adds it; active=false (PATCH/PUT) or DELETE removes
//            it from the workspace, and a managed account (an address at the
//            workspace's verified domains) is signed out everywhere. The
//            row in ent_scim_users keeps the directory's view (externalId,
//            userName, active) so a deactivated person can be re-activated.
//   Groups   the workspace's groups (lib/notes/groups.ts), members by user id.
//
// Authentication: a bearer token the owner created in Settings → Identity
// (only its HMAC is stored); a token reaches its own workspace only. The
// workspace owner can never be deprovisioned. What a directory may change on
// an account is limited to accounts it manages: renaming or re-addressing
// someone's personal account is not a workspace's business.

import { randomBytes } from "node:crypto";
import { destroyAllSessions, mac, nameFromEmail } from "../auth";
import { config } from "../config";
import { syncWorkspaceDesignLater } from "../design-sync";
import { readJsonCapped } from "../safe-json";
import { audit, sql, tx } from "../store";
import { LimitError, removeMember, roleIn, type Role } from "../workspaces";
import { addGroupMember, createGroup, deleteGroup, groupOf, GroupError, removeGroupMember, renameGroup } from "../notes/groups";
import { isWorkspaceEmail } from "./domains";
import { ssoOf } from "./sso";
import { ensureTables } from "./tables";

export const SCIM_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const SCIM_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const SCIM_ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";
const SCIM_PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const ENTERPRISE = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
const MAX_PAGE = 200;
const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]{1,190}\.[^\s@<>"',;.]{2,24}$/;

// --- Tokens ----------------------------------------------------------------------------

export interface ScimToken {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

const TOKEN_PREFIX = "zvscim_";

export function createScimToken(ws: string, actor: string, name: string): { token: string; info: ScimToken } {
  ensureTables();
  const live = sql("SELECT COUNT(*) AS n FROM ent_scim_tokens WHERE ws = ? AND revoked_at IS NULL").get(ws) as { n: number };
  if (Number(live.n) >= 10) throw new Error("too many tokens");
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const id = randomBytes(9).toString("base64url");
  const clean = name.trim().slice(0, 80) || "SCIM";
  const now = Date.now();
  sql("INSERT INTO ent_scim_tokens (id, ws, name, hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, ws, clean, mac("scim-token", token), actor, now);
  audit(actor, "scim.token.create", ws, { token: id });
  return { token, info: { id, name: clean, createdAt: now, lastUsedAt: null } };
}

export function scimTokensOf(ws: string): ScimToken[] {
  ensureTables();
  return (sql("SELECT id, name, created_at, last_used_at FROM ent_scim_tokens WHERE ws = ? AND revoked_at IS NULL ORDER BY created_at DESC").all(ws) as { id: string; name: string; created_at: number; last_used_at: number | null }[]).map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }));
}

export function revokeScimToken(ws: string, actor: string, id: string): boolean {
  ensureTables();
  const ok = Number(sql("UPDATE ent_scim_tokens SET revoked_at = ? WHERE ws = ? AND id = ? AND revoked_at IS NULL").run(Date.now(), ws, id).changes) > 0;
  if (ok) audit(actor, "scim.token.revoke", ws, { token: id });
  return ok;
}

/** The workspace and token behind an Authorization header (null: refused). */
export function scimAuth(header: string | null): { ws: string; tokenId: string } | null {
  const m = /^Bearer\s+(\S+)$/i.exec(String(header ?? "").trim());
  if (!m || !m[1].startsWith(TOKEN_PREFIX) || m[1].length > 120) return null;
  ensureTables();
  const row = sql(
    "SELECT t.id, t.ws, t.last_used_at FROM ent_scim_tokens t JOIN workspaces w ON w.id = t.ws AND w.personal = 0 WHERE t.hash = ? AND t.revoked_at IS NULL"
  ).get(mac("scim-token", m[1])) as { id: string; ws: string; last_used_at: number | null } | undefined;
  if (!row) return null;
  if (!row.last_used_at || row.last_used_at < Date.now() - 60_000) sql("UPDATE ent_scim_tokens SET last_used_at = ? WHERE id = ?").run(Date.now(), row.id);
  return { ws: row.ws, tokenId: row.id };
}

// --- Answers ---------------------------------------------------------------------------

const HEADERS = { "content-type": "application/scim+json; charset=utf-8", "cache-control": "no-store" };

function out(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
}

export function scimError(status: number, detail: string, scimType?: string): Response {
  return out({ schemas: [SCIM_ERROR], status: String(status), ...(scimType ? { scimType } : {}), detail }, status);
}

class ScimFail extends Error {
  constructor(
    public status: number,
    public detail: string,
    public scimType?: string
  ) {
    super(detail);
  }
}

const base = () => `${config.appUrl}/scim/v2`;
const iso = (ms: number) => new Date(ms).toISOString();

// --- Filters (the subset directories send) -----------------------------------------------

interface Cond {
  attr: string;
  op: "eq" | "ne" | "co" | "sw" | "ew" | "pr";
  value: string | boolean | null;
}

/** `userName eq "a@b.com"`, `externalId eq "x"`, `emails[type eq "work"].value eq "…"`, joined by "and". */
export function parseFilter(raw: string | null): Cond[] | null {
  if (!raw) return [];
  if (raw.length > 1000) return null;
  const parts = raw.split(/\s+and\s+/i);
  const conds: Cond[] = [];
  for (const p of parts) {
    const m = /^\s*([A-Za-z][\w.:$-]*(?:\[[^\]]*\])?(?:\.[A-Za-z]\w*)?)\s+(eq|ne|co|sw|ew|pr)(?:\s+(.+?))?\s*$/i.exec(p);
    if (!m) return null;
    const op = m[2].toLowerCase() as Cond["op"];
    let value: Cond["value"] = null;
    if (op !== "pr") {
      const v = (m[3] ?? "").trim();
      if (/^"(?:[^"\\]|\\.)*"$/.test(v)) {
        try {
          value = JSON.parse(v) as string;
        } catch {
          return null;
        }
      } else if (/^(true|false)$/i.test(v)) value = v.toLowerCase() === "true";
      else if (v === "null") value = null;
      else return null;
    }
    conds.push({ attr: m[1].replace(/\[[^\]]*\]/, "").toLowerCase(), op, value });
  }
  return conds;
}

function matches(got: unknown, c: Cond): boolean {
  const vals = (Array.isArray(got) ? got : [got]).filter((v) => v !== undefined && v !== null);
  if (c.op === "pr") return vals.length > 0;
  const test = (v: unknown) => {
    if (typeof c.value === "boolean") return v === c.value;
    const a = String(v).toLowerCase();
    const b = String(c.value ?? "").toLowerCase();
    if (c.op === "eq") return a === b;
    if (c.op === "ne") return a !== b;
    if (c.op === "co") return a.includes(b);
    if (c.op === "sw") return a.startsWith(b);
    return a.endsWith(b);
  };
  return c.op === "ne" ? vals.every(test) : vals.some(test);
}

function page(url: URL): { start: number; count: number } {
  const s = Number(url.searchParams.get("startIndex") ?? "1");
  const c = Number(url.searchParams.get("count") ?? String(MAX_PAGE));
  return { start: Number.isFinite(s) && s >= 1 ? Math.floor(s) : 1, count: Number.isFinite(c) && c >= 0 ? Math.min(Math.floor(c), MAX_PAGE) : MAX_PAGE };
}

function list(resources: Record<string, unknown>[], url: URL): Response {
  const { start, count } = page(url);
  const slice = resources.slice(start - 1, start - 1 + count);
  return out({ schemas: [SCIM_LIST], totalResults: resources.length, itemsPerPage: slice.length, startIndex: start, Resources: slice });
}

// --- Users -------------------------------------------------------------------------------

interface ScimRow {
  user_id: string;
  external_id: string | null;
  user_name: string;
  active: number;
  created_account: number;
  json: string;
  created_at: number;
  updated_at: number;
}

interface UserRow {
  id: string;
  name: string;
  email: string | null;
  created_at: number;
}

function scimRow(ws: string, userId: string): ScimRow | undefined {
  return sql("SELECT user_id, external_id, user_name, active, created_account, json, created_at, updated_at FROM ent_scim_users WHERE ws = ? AND user_id = ?").get(ws, userId) as ScimRow | undefined;
}

function userRow(id: string): UserRow | undefined {
  return sql("SELECT id, name, email, created_at FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

interface StoredNames {
  givenName?: string;
  familyName?: string;
  displayName?: string;
  emailType?: string;
}

function names(r: ScimRow | undefined): StoredNames {
  try {
    const v = JSON.parse(r?.json ?? "{}") as StoredNames;
    return typeof v === "object" && v ? v : {};
  } catch {
    return {};
  }
}

function userResource(ws: string, userId: string): Record<string, unknown> | null {
  const u = userRow(userId);
  if (!u) return null;
  const r = scimRow(ws, userId);
  const member = roleIn(userId, ws);
  if (!member && !r) return null;
  const n = names(r);
  const email = u.email ?? (EMAIL_RE.test(r?.user_name ?? "") ? (r?.user_name as string) : null);
  const [first, ...rest] = u.name.split(" ");
  return {
    schemas: [SCIM_USER],
    id: userId,
    ...(r?.external_id ? { externalId: r.external_id } : {}),
    userName: r?.user_name ?? email ?? userId,
    name: { givenName: n.givenName ?? first ?? "", familyName: n.familyName ?? rest.join(" "), formatted: u.name },
    displayName: n.displayName ?? u.name,
    emails: email ? [{ value: email, type: n.emailType ?? "work", primary: true }] : [],
    active: Boolean(member) && (r ? r.active === 1 : true),
    meta: { resourceType: "User", created: iso(r?.created_at ?? u.created_at), lastModified: iso(r?.updated_at ?? u.created_at), location: `${base()}/Users/${userId}` },
  };
}

function allUsers(ws: string): string[] {
  const ids = new Set<string>((sql("SELECT user_id FROM members WHERE ws_id = ? ORDER BY created_at").all(ws) as { user_id: string }[]).map((r) => r.user_id));
  for (const r of sql("SELECT user_id FROM ent_scim_users WHERE ws = ? ORDER BY created_at").all(ws) as { user_id: string }[]) ids.add(r.user_id);
  return [...ids];
}

function userAttr(res: Record<string, unknown>, attr: string): unknown {
  const emails = (res.emails as { value: string }[] | undefined) ?? [];
  const name = (res.name as Record<string, string>) ?? {};
  switch (attr) {
    case "id":
      return res.id;
    case "username":
      return res.userName;
    case "externalid":
      return res.externalId;
    case "displayname":
      return res.displayName;
    case "active":
      return res.active;
    case "emails":
    case "emails.value":
      return emails.map((e) => e.value);
    case "name.givenname":
      return name.givenName;
    case "name.familyname":
      return name.familyName;
    default:
      return undefined;
  }
}

/** The fields of a SCIM User body that zvena uses. */
interface UserInput {
  userName?: string;
  externalId?: string | null;
  givenName?: string;
  familyName?: string;
  displayName?: string;
  email?: string;
  emailType?: string;
  active?: boolean;
}

const s = (v: unknown, max = 254): string | undefined => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : typeof v === "string" && /^(true|false)$/i.test(v) ? v.toLowerCase() === "true" : undefined);

function primaryEmail(v: unknown): { value?: string; type?: string } {
  if (!Array.isArray(v)) return {};
  const list = v.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null && typeof (e as Record<string, unknown>).value === "string");
  const pick = list.find((e) => e.primary === true || e.primary === "true") ?? list.find((e) => e.type === "work") ?? list[0];
  return pick ? { value: s(pick.value), type: s(pick.type, 20) } : {};
}

function readUser(body: Record<string, unknown>): UserInput {
  const name = typeof body.name === "object" && body.name !== null ? (body.name as Record<string, unknown>) : {};
  const e = primaryEmail(body.emails);
  return {
    userName: s(body.userName),
    externalId: body.externalId === null ? null : s(body.externalId, 255),
    givenName: s(name.givenName, 120),
    familyName: s(name.familyName, 120),
    displayName: s(body.displayName, 120) ?? s(name.formatted, 120),
    email: e.value,
    emailType: e.type,
    active: bool(body.active),
  };
}

function defaultRole(ws: string): Exclude<Role, "owner"> {
  return ssoOf(ws)?.jitRole ?? "editor";
}

function addMember(ws: string, userId: string, actor: string): void {
  if (roleIn(userId, ws)) return;
  if (config.maxMembers > 0) {
    const n = sql("SELECT COUNT(*) AS n FROM members WHERE ws_id = ?").get(ws) as { n: number };
    if (Number(n.n) >= config.maxMembers) throw new LimitError("members");
  }
  const role = defaultRole(ws);
  sql("INSERT INTO members (ws_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").run(ws, userId, role, Date.now());
  audit(actor, "scim.user.activate", ws, { user: userId, role });
}

/** Removes the person from the workspace; a managed account is signed out everywhere. */
function deactivate(ws: string, userId: string, actor: string): void {
  const role = roleIn(userId, ws);
  if (role === "owner") throw new ScimFail(400, "The workspace owner cannot be deprovisioned.", "mutability");
  if (role) removeMember(actor, ws, userId);
  const u = userRow(userId);
  if (u && (isWorkspaceEmail(ws, u.email) || scimRow(ws, userId)?.created_account === 1)) destroyAllSessions(userId);
  audit(actor, "scim.user.deactivate", ws, { user: userId });
}

/** Whether the workspace's directory may change the account itself (name, address). */
function managed(ws: string, userId: string): boolean {
  const u = userRow(userId);
  return Boolean(u && (scimRow(ws, userId)?.created_account === 1 || isWorkspaceEmail(ws, u.email)));
}

function applyUser(ws: string, userId: string, input: UserInput, actor: string): void {
  const r = scimRow(ws, userId);
  if (!r) throw new ScimFail(404, "User not found.");
  const n = { ...names(r) };
  if (input.givenName !== undefined) n.givenName = input.givenName;
  if (input.familyName !== undefined) n.familyName = input.familyName;
  if (input.displayName !== undefined) n.displayName = input.displayName;
  if (input.emailType !== undefined) n.emailType = input.emailType;
  const userName = input.userName || r.user_name;
  const externalId = input.externalId === undefined ? r.external_id : input.externalId;
  sql("UPDATE ent_scim_users SET user_name = ?, external_id = ?, json = ?, updated_at = ? WHERE ws = ? AND user_id = ?").run(userName, externalId, JSON.stringify(n), Date.now(), ws, userId);
  if (managed(ws, userId)) {
    const display = (input.displayName ?? [n.givenName, n.familyName].filter(Boolean).join(" ")).trim();
    if (display && (input.displayName !== undefined || input.givenName !== undefined || input.familyName !== undefined)) sql("UPDATE users SET name = ? WHERE id = ?").run(display.slice(0, 120), userId);
    // A new address only for an account the directory created, at the workspace's own domain, not anyone else's.
    const email = (input.email ?? (EMAIL_RE.test(input.userName ?? "") ? input.userName : undefined))?.toLowerCase();
    if (email && EMAIL_RE.test(email) && r.created_account === 1 && isWorkspaceEmail(ws, email)) {
      const taken = sql("SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND id <> ?").get(email, userId);
      if (!taken) sql("UPDATE users SET email = ? WHERE id = ?").run(email, userId);
    }
  }
  if (input.active === true) {
    addMember(ws, userId, actor);
    sql("UPDATE ent_scim_users SET active = 1 WHERE ws = ? AND user_id = ?").run(ws, userId);
  } else if (input.active === false && (r.active === 1 || roleIn(userId, ws))) {
    deactivate(ws, userId, actor);
    sql("UPDATE ent_scim_users SET active = 0 WHERE ws = ? AND user_id = ?").run(ws, userId);
  }
  audit(actor, "scim.user.update", ws, { user: userId });
}

/** A member the directory did not create yet becomes "known" to it (a row with its view). */
function adopt(ws: string, userId: string, input: UserInput, createdAccount: boolean): void {
  const now = Date.now();
  const u = userRow(userId) as UserRow;
  sql("INSERT INTO ent_scim_users (ws, user_id, external_id, user_name, active, created_account, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(ws, user_id) DO NOTHING").run(
    ws,
    userId,
    input.externalId ?? null,
    input.userName || u.email || userId,
    input.active === false ? 0 : 1,
    createdAccount ? 1 : 0,
    JSON.stringify({ givenName: input.givenName, familyName: input.familyName, displayName: input.displayName, emailType: input.emailType }),
    now,
    now
  );
}

function createUser(ws: string, body: Record<string, unknown>, actor: string): Response {
  const input = readUser(body);
  if (!input.userName) throw new ScimFail(400, "userName is required.", "invalidValue");
  const email = (input.email ?? (EMAIL_RE.test(input.userName) ? input.userName : "")).toLowerCase();
  if (!EMAIL_RE.test(email)) throw new ScimFail(400, "A work email (emails or an email userName) is required.", "invalidValue");
  // The directory speaks for the workspace's own domains only (and so cannot probe which addresses have accounts).
  if (!isWorkspaceEmail(ws, email)) throw new ScimFail(400, "The email must be at one of the workspace's verified domains.", "invalidValue");
  const id = tx(() => {
    const dup = sql("SELECT user_id FROM ent_scim_users WHERE ws = ? AND user_name = ? COLLATE NOCASE").get(ws, input.userName as string) as { user_id: string } | undefined;
    if (dup) throw new ScimFail(409, "A user with this userName already exists.", "uniqueness");
    let account = (sql("SELECT id FROM users WHERE email = ? COLLATE NOCASE ORDER BY created_at LIMIT 1").get(email) as { id: string } | undefined)?.id ?? null;
    if (account && scimRow(ws, account)) throw new ScimFail(409, "A user with this email already exists.", "uniqueness");
    let created = false;
    if (!account) {
      // An account without a sign-in method yet: the person signs in later (SSO, or the e-mail link) and lands in it.
      account = randomBytes(12).toString("hex");
      const now = Date.now();
      const name = (input.displayName || [input.givenName, input.familyName].filter(Boolean).join(" ") || nameFromEmail(email) || "zvena user").slice(0, 120);
      sql("INSERT INTO users (id, name, avatar, email, created_at, last_seen_at) VALUES (?, ?, NULL, ?, ?, 0)").run(account, name, email, now);
      audit(null, "scim.account.create", ws, { user: account });
      created = true;
    }
    adopt(ws, account, input, created);
    if (input.active !== false) addMember(ws, account, actor);
    audit(actor, "scim.user.create", ws, { user: account });
    return account;
  });
  syncWorkspaceDesignLater(ws);
  return out(userResource(ws, id), 201, { location: `${base()}/Users/${id}` });
}

/** A PATCH operation's path → the UserInput field it sets (unknown paths are ignored, as directories send many). */
function patchUser(input: UserInput, op: string, path: string, value: unknown): void {
  const p = path.toLowerCase().replace(/^urn:ietf:params:scim:schemas:core:2\.0:user:/, "");
  const remove = op === "remove";
  if (p === "active") input.active = remove ? undefined : bool(value);
  else if (p === "username") input.userName = remove ? undefined : s(value);
  else if (p === "externalid") input.externalId = remove ? null : (s(value, 255) ?? null);
  else if (p === "displayname" || p === "name.formatted") input.displayName = remove ? "" : s(value, 120);
  else if (p === "name.givenname") input.givenName = remove ? "" : s(value, 120);
  else if (p === "name.familyname") input.familyName = remove ? "" : s(value, 120);
  else if (p === "name" && typeof value === "object" && value !== null) {
    const n = value as Record<string, unknown>;
    if (n.givenName !== undefined) input.givenName = s(n.givenName, 120);
    if (n.familyName !== undefined) input.familyName = s(n.familyName, 120);
    if (n.formatted !== undefined) input.displayName = s(n.formatted, 120);
  } else if (p === "emails" && !remove) {
    const e = primaryEmail(Array.isArray(value) ? value : [value]);
    if (e.value) input.email = e.value;
  } else if (/^emails\[.*\]\.value$/.test(p) && !remove && typeof value === "string") input.email = s(value);
}

function readOps(body: Record<string, unknown>): { op: string; path: string; value: unknown }[] {
  const schemas = Array.isArray(body.schemas) ? body.schemas : [];
  if (!schemas.includes(SCIM_PATCH)) throw new ScimFail(400, "A PatchOp request is expected.", "invalidSyntax");
  const ops = Array.isArray(body.Operations) ? body.Operations : null;
  if (!ops || ops.length === 0 || ops.length > 1000) throw new ScimFail(400, "Operations are required.", "invalidSyntax");
  return ops.map((o) => {
    const r = typeof o === "object" && o !== null ? (o as Record<string, unknown>) : {};
    const op = String(r.op ?? "").toLowerCase();
    if (op !== "add" && op !== "replace" && op !== "remove") throw new ScimFail(400, `Unsupported op "${String(r.op)}".`, "invalidSyntax");
    return { op, path: typeof r.path === "string" ? r.path.trim() : "", value: r.value };
  });
}

function patchUserOps(ws: string, userId: string, body: Record<string, unknown>, actor: string): Response {
  const ops = readOps(body);
  if (!userResource(ws, userId)) throw new ScimFail(404, "User not found.");
  const input: UserInput = {};
  for (const o of ops) {
    if (o.path) patchUser(input, o.op, o.path, o.value);
    else if (typeof o.value === "object" && o.value !== null) {
      // No path: the value's attributes (Okta: {"active": false}; Entra: {"name.givenName": "…"}).
      for (const [k, v] of Object.entries(o.value as Record<string, unknown>)) {
        if (k === ENTERPRISE) continue;
        patchUser(input, o.op, k, v);
      }
    }
  }
  tx(() => {
    if (!scimRow(ws, userId)) adopt(ws, userId, {}, false);
    applyUser(ws, userId, input, actor);
  });
  syncWorkspaceDesignLater(ws);
  return out(userResource(ws, userId));
}

function replaceUser(ws: string, userId: string, body: Record<string, unknown>, actor: string): Response {
  if (!userResource(ws, userId)) throw new ScimFail(404, "User not found.");
  const input = readUser(body);
  if (!input.userName) throw new ScimFail(400, "userName is required.", "invalidValue");
  // PUT replaces: an absent "active" means active (RFC 7643's default).
  if (input.active === undefined) input.active = true;
  if (input.externalId === undefined) input.externalId = null;
  tx(() => {
    const dup = sql("SELECT user_id FROM ent_scim_users WHERE ws = ? AND user_name = ? COLLATE NOCASE AND user_id <> ?").get(ws, input.userName as string, userId);
    if (dup) throw new ScimFail(409, "A user with this userName already exists.", "uniqueness");
    if (!scimRow(ws, userId)) adopt(ws, userId, {}, false);
    applyUser(ws, userId, input, actor);
  });
  syncWorkspaceDesignLater(ws);
  return out(userResource(ws, userId));
}

function deleteUser(ws: string, userId: string, actor: string): Response {
  if (!userResource(ws, userId)) throw new ScimFail(404, "User not found.");
  tx(() => {
    deactivate(ws, userId, actor);
    sql("DELETE FROM ent_scim_users WHERE ws = ? AND user_id = ?").run(ws, userId);
  });
  syncWorkspaceDesignLater(ws);
  return new Response(null, { status: 204 });
}

// --- Groups ------------------------------------------------------------------------------

function groupResource(ws: string, groupId: string, withMembers = true): Record<string, unknown> | null {
  const g = sql("SELECT id, name, created_at FROM ws_groups WHERE ws = ? AND id = ?").get(ws, groupId) as { id: string; name: string; created_at: number } | undefined;
  if (!g) return null;
  const ext = sql("SELECT external_id, updated_at FROM ent_scim_groups WHERE group_id = ?").get(groupId) as { external_id: string | null; updated_at: number } | undefined;
  const members = withMembers
    ? (sql("SELECT m.user_id, u.name FROM ws_group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY m.created_at").all(groupId) as { user_id: string; name: string }[]).map((m) => ({
        value: m.user_id,
        display: m.name,
        $ref: `${base()}/Users/${m.user_id}`,
      }))
    : undefined;
  return {
    schemas: [SCIM_GROUP],
    id: g.id,
    ...(ext?.external_id ? { externalId: ext.external_id } : {}),
    displayName: g.name,
    ...(members ? { members } : {}),
    meta: { resourceType: "Group", created: iso(g.created_at), lastModified: iso(ext?.updated_at ?? g.created_at), location: `${base()}/Groups/${g.id}` },
  };
}

function memberIds(v: unknown): string[] {
  const list = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  return list.map((m) => (typeof m === "object" && m !== null ? s((m as Record<string, unknown>).value, 64) : s(m, 64))).filter((x): x is string => Boolean(x));
}

function touchGroup(groupId: string, ws: string, externalId?: string | null): void {
  const now = Date.now();
  sql("INSERT INTO ent_scim_groups (group_id, ws, external_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(group_id) DO UPDATE SET updated_at = excluded.updated_at" + (externalId !== undefined ? ", external_id = excluded.external_id" : "")).run(
    groupId,
    ws,
    externalId ?? null,
    now,
    now
  );
}

/** Puts the workspace members among `ids` in the group (people not in the workspace are left out). */
function addMembers(ws: string, groupId: string, ids: string[], actor: string): void {
  for (const id of ids) if (roleIn(id, ws)) addGroupMember(ws, groupId, actor, id);
}

function setMembers(ws: string, groupId: string, ids: string[], actor: string): void {
  const want = new Set(ids.filter((id) => roleIn(id, ws)));
  const have = new Set((sql("SELECT user_id FROM ws_group_members WHERE group_id = ?").all(groupId) as { user_id: string }[]).map((r) => r.user_id));
  for (const id of have) if (!want.has(id)) removeGroupMember(ws, groupId, actor, id);
  for (const id of want) if (!have.has(id)) addGroupMember(ws, groupId, actor, id);
}

function nameTaken(ws: string, name: string, except = ""): boolean {
  return Boolean(sql("SELECT 1 FROM ws_groups WHERE ws = ? AND name = ? COLLATE NOCASE AND id <> ?").get(ws, name, except));
}

function createGroupScim(ws: string, body: Record<string, unknown>, actor: string): Response {
  const name = s(body.displayName, 100);
  if (!name) throw new ScimFail(400, "displayName is required.", "invalidValue");
  if (nameTaken(ws, name)) throw new ScimFail(409, "A group with this displayName already exists.", "uniqueness");
  const g = tx(() => {
    const g = createGroup(ws, actor, name);
    touchGroup(g.id, ws, s(body.externalId, 255) ?? null);
    addMembers(ws, g.id, memberIds(body.members), actor);
    return g;
  });
  audit(actor, "scim.group.create", ws, { group: g.id });
  return out(groupResource(ws, g.id), 201, { location: `${base()}/Groups/${g.id}` });
}

function patchGroupOps(ws: string, groupId: string, body: Record<string, unknown>, actor: string): Response {
  const ops = readOps(body);
  if (!groupOf(ws, groupId)) throw new ScimFail(404, "Group not found.");
  tx(() => {
    for (const o of ops) {
      const p = o.path.toLowerCase();
      if (!p && typeof o.value === "object" && o.value !== null && !Array.isArray(o.value)) {
        const v = o.value as Record<string, unknown>;
        if (typeof v.displayName === "string") {
          const name = s(v.displayName, 100) as string;
          if (nameTaken(ws, name, groupId)) throw new ScimFail(409, "A group with this displayName already exists.", "uniqueness");
          renameGroup(ws, groupId, actor, name);
        }
        if (v.externalId !== undefined) touchGroup(groupId, ws, s(v.externalId, 255) ?? null);
        if (v.members !== undefined) (o.op === "replace" ? setMembers : addMembers)(ws, groupId, memberIds(v.members), actor);
      } else if (p === "displayname" && o.op !== "remove") {
        const name = s(o.value, 100);
        if (!name) throw new ScimFail(400, "displayName is required.", "invalidValue");
        if (nameTaken(ws, name, groupId)) throw new ScimFail(409, "A group with this displayName already exists.", "uniqueness");
        renameGroup(ws, groupId, actor, name);
      } else if (p === "externalid") touchGroup(groupId, ws, o.op === "remove" ? null : (s(o.value, 255) ?? null));
      else if (p === "members") {
        if (o.op === "add") addMembers(ws, groupId, memberIds(o.value), actor);
        else if (o.op === "replace") setMembers(ws, groupId, memberIds(o.value), actor);
        else {
          // remove with a value list (Entra), or without one: everybody.
          const ids = o.value === undefined ? (sql("SELECT user_id FROM ws_group_members WHERE group_id = ?").all(groupId) as { user_id: string }[]).map((r) => r.user_id) : memberIds(o.value);
          for (const id of ids) removeGroupMember(ws, groupId, actor, id);
        }
      } else {
        // members[value eq "<id>"] (Okta's and the RFC's way to remove one member).
        const m = /^members\[value eq "([^"]{1,64})"\]$/i.exec(o.path);
        if (m && o.op === "remove") removeGroupMember(ws, groupId, actor, m[1]);
        else if (!m) throw new ScimFail(400, `Unsupported path "${o.path.slice(0, 80)}".`, "invalidPath");
      }
    }
    touchGroup(groupId, ws);
  });
  audit(actor, "scim.group.update", ws, { group: groupId });
  return out(groupResource(ws, groupId));
}

function replaceGroup(ws: string, groupId: string, body: Record<string, unknown>, actor: string): Response {
  if (!groupOf(ws, groupId)) throw new ScimFail(404, "Group not found.");
  const name = s(body.displayName, 100);
  if (!name) throw new ScimFail(400, "displayName is required.", "invalidValue");
  if (nameTaken(ws, name, groupId)) throw new ScimFail(409, "A group with this displayName already exists.", "uniqueness");
  tx(() => {
    renameGroup(ws, groupId, actor, name);
    touchGroup(groupId, ws, s(body.externalId, 255) ?? null);
    setMembers(ws, groupId, memberIds(body.members), actor);
  });
  audit(actor, "scim.group.update", ws, { group: groupId });
  return out(groupResource(ws, groupId));
}

function deleteGroupScim(ws: string, groupId: string, actor: string): Response {
  if (!groupOf(ws, groupId)) throw new ScimFail(404, "Group not found.");
  deleteGroup(ws, groupId, actor);
  audit(actor, "scim.group.delete", ws, { group: groupId });
  return new Response(null, { status: 204 });
}

function groupAttr(res: Record<string, unknown>, attr: string): unknown {
  if (attr === "displayname") return res.displayName;
  if (attr === "externalid") return res.externalId;
  if (attr === "id") return res.id;
  if (attr === "members" || attr === "members.value") return ((res.members as { value: string }[] | undefined) ?? []).map((m) => m.value);
  return undefined;
}

// --- Discovery -----------------------------------------------------------------------------

function serviceProviderConfig(): Record<string, unknown> {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    documentationUri: `${config.appUrl}/help`,
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_PAGE },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: "oauthbearertoken", name: "OAuth Bearer Token", description: "A token created in zvena's Settings → Identity → SCIM provisioning.", primary: true }],
    meta: { resourceType: "ServiceProviderConfig", location: `${base()}/ServiceProviderConfig` },
  };
}

const RESOURCE_TYPES = () => [
  { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "User", name: "User", endpoint: "/Users", description: "A workspace member", schema: SCIM_USER, meta: { resourceType: "ResourceType", location: `${base()}/ResourceTypes/User` } },
  { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "Group", name: "Group", endpoint: "/Groups", description: "A group of workspace members", schema: SCIM_GROUP, meta: { resourceType: "ResourceType", location: `${base()}/ResourceTypes/Group` } },
];

const attrDef = (name: string, type = "string", extra: Record<string, unknown> = {}) => ({ name, type, multiValued: false, required: false, caseExact: false, mutability: "readWrite", returned: "default", uniqueness: "none", ...extra });

const SCHEMAS = () => [
  {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
    id: SCIM_USER,
    name: "User",
    description: "User Account",
    attributes: [
      attrDef("userName", "string", { required: true, uniqueness: "server" }),
      attrDef("externalId", "string", { caseExact: true }),
      attrDef("name", "complex", { subAttributes: [attrDef("givenName"), attrDef("familyName"), attrDef("formatted")] }),
      attrDef("displayName"),
      attrDef("active", "boolean"),
      attrDef("emails", "complex", { multiValued: true, subAttributes: [attrDef("value"), attrDef("type"), attrDef("primary", "boolean")] }),
    ],
    meta: { resourceType: "Schema", location: `${base()}/Schemas/${SCIM_USER}` },
  },
  {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
    id: SCIM_GROUP,
    name: "Group",
    description: "Group",
    attributes: [
      attrDef("displayName", "string", { required: true }),
      attrDef("externalId", "string", { caseExact: true }),
      attrDef("members", "complex", { multiValued: true, subAttributes: [attrDef("value", "string", { mutability: "immutable" }), attrDef("display", "string", { mutability: "readOnly" })] }),
    ],
    meta: { resourceType: "Schema", location: `${base()}/Schemas/${SCIM_GROUP}` },
  },
];

// --- The router ------------------------------------------------------------------------------

async function bodyOf(req: Request): Promise<Record<string, unknown>> {
  const p = await readJsonCapped(req, 1_000_000);
  if (!p.ok) throw new ScimFail(p.status === 413 ? 413 : 400, p.status === 413 ? "Request too large." : "The body is not JSON.", p.status === 413 ? undefined : "invalidSyntax");
  if (typeof p.value !== "object" || p.value === null || Array.isArray(p.value)) throw new ScimFail(400, "A JSON object is expected.", "invalidSyntax");
  return p.value as Record<string, unknown>;
}

/** Handles /scim/v2/<path…> for the workspace of an authenticated token. */
export async function scimRequest(req: Request, path: string[], who: { ws: string; tokenId: string }): Promise<Response> {
  ensureTables();
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  const actor = `scim:${who.tokenId}`;
  const [resource, id, ...rest] = path;
  if (rest.length) return scimError(404, "Not found.");
  try {
    if (resource === "ServiceProviderConfig" && !id && method === "GET") return out(serviceProviderConfig());
    if (resource === "ResourceTypes" && method === "GET") {
      const all = RESOURCE_TYPES();
      if (id) return all.find((r) => r.id === id) ? out(all.find((r) => r.id === id)) : scimError(404, "Not found.");
      return list(all, url);
    }
    if (resource === "Schemas" && method === "GET") {
      const all = SCHEMAS();
      if (id) return all.find((r) => r.id === id) ? out(all.find((r) => r.id === id)) : scimError(404, "Not found.");
      return list(all, url);
    }
    if (resource === "Users") {
      if (!id && method === "GET") {
        const conds = parseFilter(url.searchParams.get("filter"));
        if (!conds) return scimError(400, "The filter is not supported.", "invalidFilter");
        const all = allUsers(who.ws)
          .map((u) => userResource(who.ws, u))
          .filter((r): r is Record<string, unknown> => r !== null)
          .filter((r) => conds.every((c) => matches(userAttr(r, c.attr), c)));
        return list(all, url);
      }
      if (!id && method === "POST") return createUser(who.ws, await bodyOf(req), actor);
      if (id && !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return scimError(404, "User not found.");
      if (id && method === "GET") {
        const r = userResource(who.ws, id);
        return r ? out(r) : scimError(404, "User not found.");
      }
      if (id && method === "PUT") return replaceUser(who.ws, id, await bodyOf(req), actor);
      if (id && method === "PATCH") return patchUserOps(who.ws, id, await bodyOf(req), actor);
      if (id && method === "DELETE") return deleteUser(who.ws, id, actor);
    }
    if (resource === "Groups") {
      const withMembers = !/(^|,)\s*members\s*(,|$)/i.test(url.searchParams.get("excludedAttributes") ?? "");
      if (!id && method === "GET") {
        const conds = parseFilter(url.searchParams.get("filter"));
        if (!conds) return scimError(400, "The filter is not supported.", "invalidFilter");
        const all = (sql("SELECT id FROM ws_groups WHERE ws = ? ORDER BY created_at").all(who.ws) as { id: string }[])
          .map((g) => groupResource(who.ws, g.id, true))
          .filter((r): r is Record<string, unknown> => r !== null)
          .filter((r) => conds.every((c) => matches(groupAttr(r, c.attr), c)))
          .map((r) => (withMembers ? r : (({ members: _m, ...rest }) => (void _m, rest))(r)));
        return list(all, url);
      }
      if (!id && method === "POST") return createGroupScim(who.ws, await bodyOf(req), actor);
      if (id && !/^[A-Za-z0-9_-]{8,40}$/.test(id)) return scimError(404, "Group not found.");
      if (id && method === "GET") {
        const r = groupResource(who.ws, id, withMembers);
        return r ? out(r) : scimError(404, "Group not found.");
      }
      if (id && method === "PUT") return replaceGroup(who.ws, id, await bodyOf(req), actor);
      if (id && method === "PATCH") return patchGroupOps(who.ws, id, await bodyOf(req), actor);
      if (id && method === "DELETE") return deleteGroupScim(who.ws, id, actor);
    }
    return scimError(method === "GET" || method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE" ? 404 : 405, "Not found.");
  } catch (e) {
    if (e instanceof ScimFail) return scimError(e.status, e.detail, e.scimType);
    if (e instanceof LimitError) return scimError(409, "The workspace has reached its member limit.", "tooMany");
    if (e instanceof GroupError) return scimError(400, e.message, "invalidValue");
    throw e;
  }
}
