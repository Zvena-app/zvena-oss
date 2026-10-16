// Server-only: a workspace's audit log (Notion's Settings → Audit log), read
// from the security journal (store.ts audit()). A workspace's lines are those
// about it (target = the workspace), the pages it published, and its
// members' own account events (sign-ins, sign-ups, sign-outs everywhere,
// exports) since they joined it: what someone did before (or a guest at any
// time) is not the workspace's business. The journal keeps ids, never e-mails, addresses or content;
// names are looked up when the log is shown.

import { sql, store, storePath } from "../store";
import { ensureTables } from "./tables";

/** Account events of a member that belong in their workspaces' logs. */
const ACCOUNT_ACTIONS = ["signin", "signup", "identity-linked", "sessions.revoke", "data.export", "consent"];

export interface AuditEntry {
  /** The journal line (the cursor of the next page). */
  id: number;
  at: number;
  actor: string | null;
  actorName: string;
  action: string;
  target: string | null;
  meta: Record<string, unknown> | null;
  /** Names of the people the line is about (meta.user), when known. */
  subjectName?: string;
}

export interface AuditQuery {
  actor?: string | null;
  /** Exact actions ("member.remove") or families ("member." / "sso."), comma-separated. */
  action?: string | null;
  from?: number | null;
  to?: number | null;
  /** Lines older than this one (its id: the next page). */
  before?: number | null;
  limit?: number;
}

let indexed = "";
function indexes(): void {
  ensureTables();
  const key = storePath();
  if (indexed === key) return;
  const d = store();
  // The log reads the journal by workspace and by person.
  d.exec("CREATE INDEX IF NOT EXISTS audit_target ON audit(target, at); CREATE INDEX IF NOT EXISTS audit_actor ON audit(actor, at);");
  indexed = key;
}

function where(ws: string, q: AuditQuery): { clause: string; args: (string | number)[] } {
  const parts = [
    `(a.target = ? OR (a.action IN ('page.publish', 'page.unpublish') AND a.target IN (SELECT id FROM note_shares WHERE ws = ?)) OR (a.action IN (${ACCOUNT_ACTIONS.map(() => "?").join(", ")}) AND EXISTS (SELECT 1 FROM members m WHERE m.ws_id = ? AND m.user_id = a.actor AND m.created_at <= a.at)))`,
  ];
  const args: (string | number)[] = [ws, ws, ...ACCOUNT_ACTIONS, ws];
  if (q.actor) {
    parts.push("a.actor = ?");
    args.push(q.actor);
  }
  const actions = (q.action ?? "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 20);
  if (actions.length) {
    const any: string[] = [];
    for (const a of actions) {
      if (a.endsWith(".")) {
        any.push("substr(a.action, 1, ?) = ?");
        args.push(a.length, a);
      } else {
        any.push("a.action = ?");
        args.push(a);
      }
    }
    parts.push(`(${any.join(" OR ")})`);
  }
  if (q.from) {
    parts.push("a.at >= ?");
    args.push(q.from);
  }
  if (q.to) {
    parts.push("a.at <= ?");
    args.push(q.to);
  }
  if (q.before) {
    parts.push("a.rowid < ?");
    args.push(q.before);
  }
  return { clause: parts.join(" AND "), args };
}

function names(ws: string): (id: string | null) => string {
  const cache = new Map<string, string>();
  return (id) => {
    if (!id) return "";
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    let n = "";
    if (id.startsWith("scim:")) {
      const t = sql("SELECT name FROM ent_scim_tokens WHERE ws = ? AND id = ?").get(ws, id.slice(5)) as { name: string } | undefined;
      n = `SCIM${t ? ` (${t.name})` : ""}`;
    } else n = (sql("SELECT name FROM users WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? "";
    cache.set(id, n);
    return n;
  };
}

function parseMeta(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function auditEntries(ws: string, q: AuditQuery): { entries: AuditEntry[]; more: boolean } {
  indexes();
  const limit = Math.min(Math.max(Math.floor(q.limit ?? 100), 1), 500);
  const w = where(ws, q);
  const rows = sql(`SELECT a.rowid AS id, a.at, a.actor, a.action, a.target, a.meta FROM audit a WHERE ${w.clause} ORDER BY a.rowid DESC LIMIT ?`).all(...w.args, limit + 1) as {
    id: number;
    at: number;
    actor: string | null;
    action: string;
    target: string | null;
    meta: string | null;
  }[];
  const name = names(ws);
  const entries = rows.slice(0, limit).map((r) => {
    const meta = parseMeta(r.meta);
    const subject = typeof meta?.user === "string" ? name(meta.user) : "";
    return { id: Number(r.id), at: Number(r.at), actor: r.actor, actorName: name(r.actor), action: r.action, target: r.target, meta, ...(subject ? { subjectName: subject } : {}) };
  });
  return { entries, more: rows.length > limit };
}

/** The people and actions that appear in the log (the filters' choices). */
export function auditFacets(ws: string): { actors: { id: string; name: string }[]; actions: string[] } {
  indexes();
  const w = where(ws, {});
  const actors = (sql(`SELECT DISTINCT a.actor FROM audit a WHERE ${w.clause} AND a.actor IS NOT NULL LIMIT 500`).all(...w.args) as { actor: string }[]).map((r) => r.actor);
  const actions = (sql(`SELECT DISTINCT a.action FROM audit a WHERE ${w.clause} ORDER BY a.action LIMIT 500`).all(...w.args) as { action: string }[]).map((r) => r.action);
  const name = names(ws);
  return { actors: actors.map((id) => ({ id, name: name(id) || id })).sort((a, b) => a.name.localeCompare(b.name)), actions };
}

/** A spreadsheet cell: quoted, and never a formula when opened in Excel or Sheets. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** The log as CSV lines (newest first, at most 50 000), header first. */
export function* auditCsv(ws: string, q: AuditQuery): Generator<string> {
  yield `${["time", "actor_id", "actor", "action", "target", "subject", "details"].map(csvCell).join(",")}\r\n`;
  let before = q.before ?? null;
  let n = 0;
  while (n < 50_000) {
    const { entries, more } = auditEntries(ws, { ...q, before, limit: 500 });
    for (const e of entries) yield `${[new Date(e.at).toISOString(), e.actor ?? "", e.actorName, e.action, e.target ?? "", e.subjectName ?? "", e.meta ?? ""].map(csvCell).join(",")}\r\n`;
    n += entries.length;
    if (!more || entries.length === 0) break;
    before = entries[entries.length - 1].id;
  }
}
