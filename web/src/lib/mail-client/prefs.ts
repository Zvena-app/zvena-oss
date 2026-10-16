// Server-only: a person's Mail settings, views and snippets.

import { newId, sql } from "../store";
import { mailDb } from "./schema";
import { DEFAULT_PREFS, type MailPrefs, type MailSnippet, type MailView } from "./types";
import { cleanFilter, isSystemView, systemFilter, SYSTEM_VIEWS, type SystemView } from "./views";

interface StoredPrefs extends MailPrefs {
  /** The workspace Mail was last opened in (its Inbox gets the notifications). */
  ws?: string;
  /** Built-in views with notifications on. */
  notify?: SystemView[];
}

const WS_RE = /^[A-Za-z0-9_-]{8,40}$/;
const VIEW_ID_RE = /^[A-Za-z0-9_-]{4,40}$/;

export function prefsOf(userId: string): StoredPrefs {
  mailDb();
  const r = sql("SELECT json FROM mail_prefs WHERE user_id = ?").get(userId) as { json: string } | undefined;
  let p: Partial<StoredPrefs> = {};
  try {
    p = r ? (JSON.parse(r.json) as Partial<StoredPrefs>) : {};
  } catch {
    p = {};
  }
  return { ...DEFAULT_PREFS, ...p };
}

/** Saves the settings a person may change (bad values are ignored). */
export function setPrefs(userId: string, v: Record<string, unknown>): StoredPrefs {
  const p = prefsOf(userId);
  if (typeof v.undoSeconds === "number" && [0, 5, 10, 20, 30].includes(v.undoSeconds)) p.undoSeconds = v.undoSeconds;
  if (typeof v.alwaysImages === "boolean") p.alwaysImages = v.alwaysImages;
  if (v.pane === "split" || v.pane === "full") p.pane = v.pane;
  if (v.density === "compact" || v.density === "comfortable") p.density = v.density;
  if (Array.isArray(v.tabs)) p.tabs = v.tabs.filter((t): t is string => typeof t === "string" && VIEW_ID_RE.test(t)).slice(0, 12);
  if (typeof v.ws === "string" && WS_RE.test(v.ws)) p.ws = v.ws;
  if (Array.isArray(v.notify)) p.notify = v.notify.filter(isSystemView);
  sql("INSERT INTO mail_prefs (user_id, json) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json").run(userId, JSON.stringify(p));
  return p;
}

const SYSTEM_ICONS: Record<SystemView, string> = { inbox: "inbox", unread: "unread", starred: "star", snoozed: "clock", sent: "send", drafts: "file", archive: "archive", spam: "spam", trash: "trash" };

interface ViewRow {
  id: string;
  name: string;
  icon: string;
  filter: string;
  notify: number;
}

/** Built-in views first, then the person's own, each with its notification setting. */
export function viewsOf(userId: string): MailView[] {
  mailDb();
  const p = prefsOf(userId);
  const sys: MailView[] = SYSTEM_VIEWS.map((id) => ({ id, name: "", icon: SYSTEM_ICONS[id], filter: systemFilter(id), notify: (p.notify ?? []).includes(id), system: true }));
  const own = (sql("SELECT id, name, icon, filter, notify FROM mail_views WHERE user_id = ? ORDER BY position, created_at").all(userId) as unknown as ViewRow[]).map((r) => {
    let filter = {};
    try {
      filter = cleanFilter(JSON.parse(r.filter));
    } catch {
      filter = {};
    }
    return { id: r.id, name: r.name, icon: r.icon, filter, notify: r.notify === 1, system: false };
  });
  return [...sys, ...own];
}

export function viewOf(userId: string, id: string): MailView | null {
  return viewsOf(userId).find((v) => v.id === id) ?? null;
}

const MAX_VIEWS = 50;

export function createView(userId: string, v: { name?: unknown; icon?: unknown; filter?: unknown; notify?: unknown }): MailView | null {
  mailDb();
  const name = typeof v.name === "string" ? v.name.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  if (!name) return null;
  const n = Number((sql("SELECT COUNT(*) AS n FROM mail_views WHERE user_id = ?").get(userId) as { n: number }).n);
  if (n >= MAX_VIEWS) return null;
  const id = newId(9);
  const filter = cleanFilter(v.filter);
  const icon = typeof v.icon === "string" ? v.icon.slice(0, 16) : "";
  sql("INSERT INTO mail_views (id, user_id, name, icon, filter, notify, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, userId, name, icon, JSON.stringify(filter), v.notify === true ? 1 : 0, n, Date.now());
  return { id, name, icon, filter, notify: v.notify === true, system: false };
}

/** Changes a view; a built-in one only takes its notification setting. */
export function updateView(userId: string, id: string, v: { name?: unknown; icon?: unknown; filter?: unknown; notify?: unknown; position?: unknown }): boolean {
  if (isSystemView(id)) {
    if (typeof v.notify !== "boolean") return false;
    const cur = new Set(prefsOf(userId).notify ?? []);
    if (v.notify) cur.add(id);
    else cur.delete(id);
    setPrefs(userId, { notify: [...cur] });
    return true;
  }
  const r = sql("SELECT id FROM mail_views WHERE id = ? AND user_id = ?").get(id, userId);
  if (!r) return false;
  if (typeof v.name === "string" && v.name.trim()) sql("UPDATE mail_views SET name = ? WHERE id = ?").run(v.name.replace(/\s+/g, " ").trim().slice(0, 60), id);
  if (typeof v.icon === "string") sql("UPDATE mail_views SET icon = ? WHERE id = ?").run(v.icon.slice(0, 16), id);
  if (v.filter !== undefined) sql("UPDATE mail_views SET filter = ? WHERE id = ?").run(JSON.stringify(cleanFilter(v.filter)), id);
  if (typeof v.notify === "boolean") sql("UPDATE mail_views SET notify = ? WHERE id = ?").run(v.notify ? 1 : 0, id);
  if (typeof v.position === "number" && Number.isFinite(v.position)) sql("UPDATE mail_views SET position = ? WHERE id = ?").run(Math.floor(v.position), id);
  return true;
}

export function deleteView(userId: string, id: string): boolean {
  return Number(sql("DELETE FROM mail_views WHERE id = ? AND user_id = ?").run(id, userId).changes) > 0;
}

// --- Snippets ----------------------------------------------------------------------

const MAX_SNIPPETS = 200;

export function snippetsOf(userId: string): MailSnippet[] {
  mailDb();
  return sql("SELECT id, name, html FROM mail_snippets WHERE user_id = ? ORDER BY position, lower(name)").all(userId) as unknown as MailSnippet[];
}

export function saveSnippet(userId: string, id: string | null, v: { name?: unknown; html?: unknown }, clean: (html: string) => string): MailSnippet | null {
  mailDb();
  const name = typeof v.name === "string" ? v.name.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  const html = typeof v.html === "string" ? clean(v.html.slice(0, 100_000)) : "";
  if (!name) return null;
  const now = Date.now();
  if (id) {
    const ok = Number(sql("UPDATE mail_snippets SET name = ?, html = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(name, html, now, id, userId).changes) > 0;
    return ok ? { id, name, html } : null;
  }
  const n = Number((sql("SELECT COUNT(*) AS n FROM mail_snippets WHERE user_id = ?").get(userId) as { n: number }).n);
  if (n >= MAX_SNIPPETS) return null;
  const sid = newId(9);
  sql("INSERT INTO mail_snippets (id, user_id, name, html, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(sid, userId, name, html, n, now, now);
  return { id: sid, name, html };
}

export function deleteSnippet(userId: string, id: string): boolean {
  return Number(sql("DELETE FROM mail_snippets WHERE id = ? AND user_id = ?").run(id, userId).changes) > 0;
}
