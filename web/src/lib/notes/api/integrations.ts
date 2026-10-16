// Server-only: internal integrations of a workspace (Notion's "connections")
// — a named bot with a secret token, a set of capabilities, the pages it was
// connected to (it sees those and everything under them, nothing else), and
// optionally a webhook endpoint.

import { randomBytes } from "node:crypto";
import { mac } from "../../auth";
import { audit, sql, tx } from "../../store";
import { roleIn } from "../../workspaces";
import { apiTables } from "./schema";

export interface Capabilities {
  /** Read pages, blocks, databases (always needed for anything else to make sense). */
  read: boolean;
  /** Change existing content (pages, blocks, databases, trash). */
  update: boolean;
  /** Create pages, databases and append blocks. */
  insert: boolean;
  readComments: boolean;
  insertComments: boolean;
  /** People: none, names (and avatars), or names with e-mail addresses. */
  users: "none" | "names" | "emails";
}

export const DEFAULT_CAPS: Capabilities = { read: true, update: true, insert: true, readComments: true, insertComments: true, users: "names" };

export const WEBHOOK_EVENTS = [
  "page.created",
  "page.content_updated",
  "page.properties_updated",
  "page.deleted",
  "database.created",
  "database.schema_updated",
  "database.deleted",
  // Notion API 2025-09-03: a database's data sources (each database note: its first, or a further one).
  "data_source.created",
  "data_source.schema_updated",
  "data_source.deleted",
  "comment.created",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface Integration {
  id: string;
  ws: string;
  name: string;
  icon: string;
  caps: Capabilities;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  webhook: { url: string; events: WebhookEvent[] } | null;
}

interface Row {
  id: string;
  ws: string;
  name: string;
  icon: string;
  caps: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
  webhook_url: string | null;
  webhook_events: string | null;
  webhook_nonce: string | null;
}

export const INTEGRATION_ID_RE = /^[a-f0-9]{32}$/;
const SECRET_RE = /^zv_secret_[A-Za-z0-9_-]{43}$/;
const MAX_PER_WS = 20;

export function cleanCaps(v: unknown): Capabilities {
  const r = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  const flag = (k: keyof Capabilities, def: boolean) => (typeof r[k] === "boolean" ? (r[k] as boolean) : def);
  return {
    read: true,
    update: flag("update", DEFAULT_CAPS.update),
    insert: flag("insert", DEFAULT_CAPS.insert),
    readComments: flag("readComments", DEFAULT_CAPS.readComments),
    insertComments: flag("insertComments", DEFAULT_CAPS.insertComments),
    users: r.users === "none" || r.users === "emails" ? r.users : "names",
  };
}

function cleanName(v: unknown): string {
  return typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, 80) : "";
}

function cleanIconText(v: unknown): string {
  return typeof v === "string" && !/[<>]/.test(v) && !/^[a-z][a-z0-9+.-]*:/i.test(v) ? v.slice(0, 16) : "";
}

/** An https endpoint on a default port (SSRF is checked again when sending). */
export function cleanWebhookUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 2000) return null;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function toIntegration(r: Row): Integration {
  let caps = DEFAULT_CAPS;
  try {
    caps = cleanCaps(JSON.parse(r.caps));
  } catch {
    // Unreadable: the defaults.
  }
  let events: WebhookEvent[] = [];
  try {
    const list = JSON.parse(r.webhook_events ?? "[]") as unknown;
    events = Array.isArray(list) ? WEBHOOK_EVENTS.filter((e) => list.includes(e)) : [];
  } catch {
    events = [];
  }
  return {
    id: r.id,
    ws: r.ws,
    name: r.name,
    icon: r.icon,
    caps,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    webhook: r.webhook_url ? { url: r.webhook_url, events } : null,
  };
}

const COLS = "id, ws, name, icon, caps, created_by, created_at, updated_at, revoked_at, webhook_url, webhook_events, webhook_nonce";

function newSecret(): string {
  return `zv_secret_${randomBytes(32).toString("base64url")}`;
}

export class IntegrationLimitError extends Error {}

/**
 * Who manages an integration: the person who made it, or the workspace's
 * owner. Only they change it, rotate its secret, see its webhook and
 * capabilities, or revoke it — an editor never takes over someone else's
 * (its secret reads what that person connected).
 */
export function managesIntegration(userId: string, ws: string, i: Pick<Integration, "createdBy" | "ws">): boolean {
  return i.ws === ws && (i.createdBy === userId || roleIn(userId, ws) === "owner");
}

/** The integration as `userId` may see it in a list: everything for those who manage it, else its name and icon. */
export function integrationView(userId: string, ws: string, i: Integration): Integration | Pick<Integration, "id" | "name" | "icon"> {
  return managesIntegration(userId, ws, i) ? i : { id: i.id, name: i.name, icon: i.icon };
}

function managedRow(actor: string, ws: string, id: string): Row | null {
  const cur = sql(`SELECT ${COLS} FROM integrations WHERE id = ? AND ws = ? AND revoked_at IS NULL`).get(id, ws) as Row | undefined;
  if (!cur) return null;
  if (!managesIntegration(actor, ws, { ws: cur.ws, createdBy: cur.created_by })) throw new IntegrationForbiddenError("not yours");
  return cur;
}

/** Someone who does not manage the integration (lib: managesIntegration) tried to change it. */
export class IntegrationForbiddenError extends Error {}

/** A new integration; its secret is returned once (only its HMAC is stored). */
export function createIntegration(actor: string, ws: string, input: { name?: unknown; icon?: unknown; caps?: unknown }): { integration: Integration; secret: string } {
  apiTables();
  const name = cleanName(input.name) || "Integration";
  return tx(() => {
    const n = sql("SELECT COUNT(*) AS n FROM integrations WHERE ws = ? AND revoked_at IS NULL").get(ws) as { n: number };
    if (Number(n.n) >= MAX_PER_WS) throw new IntegrationLimitError("integrations");
    const id = randomBytes(16).toString("hex");
    const secret = newSecret();
    const now = Date.now();
    sql("INSERT INTO integrations (id, ws, name, icon, caps, secret_hash, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      id,
      ws,
      name,
      cleanIconText(input.icon),
      JSON.stringify(cleanCaps(input.caps)),
      mac("integration", secret),
      actor,
      now,
      now
    );
    audit(actor, "integration.create", ws, { integration: id });
    return { integration: getIntegration(id) as Integration, secret };
  });
}

export function getIntegration(id: string): Integration | null {
  apiTables();
  if (!INTEGRATION_ID_RE.test(id)) return null;
  const r = sql(`SELECT ${COLS} FROM integrations WHERE id = ? AND revoked_at IS NULL`).get(id) as Row | undefined;
  return r ? toIntegration(r) : null;
}

export function listIntegrations(ws: string): Integration[] {
  apiTables();
  return (sql(`SELECT ${COLS} FROM integrations WHERE ws = ? AND revoked_at IS NULL ORDER BY created_at`).all(ws) as unknown as Row[]).map(toIntegration);
}

/** The integration a Bearer token belongs to (null: unknown, revoked or malformed). */
export function integrationBySecret(token: string): Integration | null {
  apiTables();
  if (!SECRET_RE.test(token)) return null;
  const r = sql(`SELECT ${COLS} FROM integrations WHERE secret_hash = ? AND revoked_at IS NULL`).get(mac("integration", token)) as Row | undefined;
  return r ? toIntegration(r) : null;
}

/**
 * Changes name, icon, capabilities or the webhook. Setting a webhook (or a
 * new URL) issues a new signing secret, returned once.
 */
export function updateIntegration(
  actor: string,
  ws: string,
  id: string,
  patch: { name?: unknown; icon?: unknown; caps?: unknown; webhook?: { url?: unknown; events?: unknown } | null }
): { integration: Integration; webhookSecret?: string } | null {
  apiTables();
  const cur = managedRow(actor, ws, id);
  if (!cur) return null;
  const name = patch.name !== undefined ? cleanName(patch.name) || cur.name : cur.name;
  const icon = patch.icon !== undefined ? cleanIconText(patch.icon) : cur.icon;
  const caps = patch.caps !== undefined ? JSON.stringify(cleanCaps(patch.caps)) : cur.caps;
  let url = cur.webhook_url;
  let events = cur.webhook_events;
  let nonce = cur.webhook_nonce;
  let webhookSecret: string | undefined;
  if (patch.webhook === null) {
    url = null;
    events = null;
    nonce = null;
  } else if (patch.webhook) {
    const next = cleanWebhookUrl(patch.webhook.url);
    if (!next) throw new Error("bad webhook url");
    const list = Array.isArray(patch.webhook.events) ? WEBHOOK_EVENTS.filter((e) => (patch.webhook?.events as unknown[]).includes(e)) : [...WEBHOOK_EVENTS];
    if (next !== url || !nonce) {
      nonce = randomBytes(16).toString("base64url");
      webhookSecret = signingSecret(id, nonce);
    }
    url = next;
    events = JSON.stringify(list);
  }
  sql("UPDATE integrations SET name = ?, icon = ?, caps = ?, webhook_url = ?, webhook_events = ?, webhook_nonce = ?, updated_at = ? WHERE id = ?").run(name, icon, caps, url, events, nonce, Date.now(), id);
  audit(actor, "integration.update", ws, { integration: id });
  return { integration: getIntegration(id) as Integration, ...(webhookSecret ? { webhookSecret } : {}) };
}

/** A new secret token; the old one stops working at once. */
export function rotateSecret(actor: string, ws: string, id: string): string | null {
  apiTables();
  if (!managedRow(actor, ws, id)) return null;
  const secret = newSecret();
  const ok = Number(sql("UPDATE integrations SET secret_hash = ?, updated_at = ? WHERE id = ? AND ws = ? AND revoked_at IS NULL").run(mac("integration", secret), Date.now(), id, ws).changes) > 0;
  if (!ok) return null;
  audit(actor, "integration.rotate", ws, { integration: id });
  return secret;
}

export function revokeIntegration(actor: string, ws: string, id: string): boolean {
  apiTables();
  if (!managedRow(actor, ws, id)) return false;
  const ok = tx(() => {
    const done = Number(sql("UPDATE integrations SET revoked_at = ?, webhook_url = NULL, webhook_nonce = NULL WHERE id = ? AND ws = ? AND revoked_at IS NULL").run(Date.now(), id, ws).changes) > 0;
    if (done) sql("DELETE FROM integration_pages WHERE integration_id = ?").run(id);
    return done;
  });
  if (ok) audit(actor, "integration.revoke", ws, { integration: id });
  return ok;
}

/** The webhook signing secret (derived, never stored): "zv_whsec_…". */
export function signingSecret(id: string, nonce: string): string {
  return `zv_whsec_${mac("integration-webhook", `${id}:${nonce}`)}`;
}

export function webhookSecretOf(id: string): string | null {
  apiTables();
  const r = sql("SELECT webhook_nonce FROM integrations WHERE id = ? AND revoked_at IS NULL").get(id) as { webhook_nonce: string | null } | undefined;
  return r?.webhook_nonce ? signingSecret(id, r.webhook_nonce) : null;
}

// --- Connections ---------------------------------------------------------------

export function connectPage(actor: string, ws: string, integrationId: string, noteId: string): boolean {
  apiTables();
  if (getIntegration(integrationId)?.ws !== ws) return false;
  // Only a page of the same workspace.
  if (!sql("SELECT 1 FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, noteId)) return false;
  sql("INSERT INTO integration_pages (integration_id, ws, note_id, added_by, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(integration_id, note_id) DO NOTHING").run(integrationId, ws, noteId, actor, Date.now());
  audit(actor, "integration.connect", ws, { integration: integrationId });
  return true;
}

export function disconnectPage(actor: string, ws: string, integrationId: string, noteId: string): boolean {
  apiTables();
  const ok = Number(sql("DELETE FROM integration_pages WHERE integration_id = ? AND ws = ? AND note_id = ?").run(integrationId, ws, noteId).changes) > 0;
  if (ok) audit(actor, "integration.disconnect", ws, { integration: integrationId });
  return ok;
}

/** Integrations connected directly to a page. */
export function connectionsOf(ws: string, noteId: string): string[] {
  apiTables();
  return (sql("SELECT p.integration_id AS id FROM integration_pages p JOIN integrations i ON i.id = p.integration_id WHERE p.ws = ? AND p.note_id = ? AND i.revoked_at IS NULL").all(ws, noteId) as { id: string }[]).map((r) => r.id);
}

/** A page's connections: made on the page itself, and inherited from pages above it. */
export function connectionChain(ws: string, noteId: string): { direct: string[]; inherited: { id: string; from: string }[] } {
  apiTables();
  const direct = connectionsOf(ws, noteId);
  const inherited: { id: string; from: string }[] = [];
  const seen = new Set<string>([noteId]);
  let cur: string | null = noteId;
  for (let depth = 0; cur && depth < 100; depth++) {
    const r = sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, cur) as { json: string | null } | undefined;
    let parent: string | null = null;
    try {
      parent = (JSON.parse(r?.json ?? "null") as { parentId?: string | null } | null)?.parentId ?? null;
    } catch {
      parent = null;
    }
    if (!parent || seen.has(parent)) break;
    seen.add(parent);
    for (const id of connectionsOf(ws, parent)) if (!direct.includes(id) && !inherited.some((x) => x.id === id)) inherited.push({ id, from: parent });
    cur = parent;
  }
  return { direct, inherited };
}

/** The pages an integration was connected to (roots of what it sees). */
/**
 * The pages connected to an integration and who connected each: the
 * integration never sees or changes more than that person may (a restricted
 * sub-page, a teamspace they left, the workspace after they leave).
 */
export function connectorsOf(integrationId: string): Map<string, string> {
  apiTables();
  return new Map((sql("SELECT note_id, added_by FROM integration_pages WHERE integration_id = ?").all(integrationId) as { note_id: string; added_by: string }[]).map((r) => [r.note_id, r.added_by]));
}

export function pagesOf(integrationId: string): string[] {
  apiTables();
  return (sql("SELECT note_id FROM integration_pages WHERE integration_id = ?").all(integrationId) as { note_id: string }[]).map((r) => r.note_id);
}

/** A deleted workspace takes its integrations along. */
export function dropWorkspaceIntegrations(ws: string): void {
  apiTables();
  sql("DELETE FROM integration_pages WHERE ws = ?").run(ws);
  sql("DELETE FROM integrations WHERE ws = ?").run(ws);
}

/** Integration names by "integration:<id>" (for "Created by" / "Last edited by"), live ones only. */
export function integrationNames(ws: string): { id: string; name: string; icon: string }[] {
  return listIntegrations(ws).map((i) => ({ id: `integration:${i.id}`, name: i.name, icon: i.icon }));
}
