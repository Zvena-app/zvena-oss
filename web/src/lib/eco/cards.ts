// Cards: what a person sees of any object, by its ref key. Server-only.
//
// Each product answers for its own objects and its own rules of access:
// Documents from the ecosystem's catalog with Documents' own page access
// (Private pages, teamspaces, invite-only pages; trash and hidden notes are
// never shown), Projects through its
// permission-checked functions (private teams stay private), Design through
// Penpot as that person (only files of the workspace's Design team),
// Calendar by the share level of the event's calendar (or being its guest).
// A key the person may not see simply gets no card.

import { AccessResolver } from "../notes/access";
import { displayTitle, noteSlug } from "../notes/model";
import { ctxFor, type Ctx } from "../projects/core";
import { issuesByIds } from "../projects/issues";
import { listProjects } from "../projects/planning";
import { listStatuses } from "../projects/teams";
import { statusFraction, type ProjectState } from "../projects/types";
import { designConfigured, fileFrames } from "../penpot";
import { threadBriefs } from "../mail-client/store";
import { sql } from "../store";
import { eventCards } from "./calendar";
import { requestIndex } from "./indexer";
import { parseRefKey, refHref, refKey, type Ref } from "./refs";
import { ecoDb } from "./schema";
import { ecoText, type EcoKey } from "./strings";
import type { Card, StatusCategory } from "./types";
import type { Locale } from "@/i18n/locales";

export interface Viewer {
  userId: string;
  wsId: string;
  /** The interface's language: the cards' own words (Untitled, a project's state…). */
  locale: Locale;
}

/** The cards' own words in the viewer's language. */
function words(locale: string) {
  const w = (k: EcoKey) => ecoText(locale, k);
  return {
    untitled: w("untitled"),
    row: w("rowIn"),
    design: w("design"),
    frame: w("frame"),
    backlog: w("state_backlog"),
    planned: w("state_planned"),
    started: w("state_started"),
    paused: w("state_paused"),
    completed: w("state_completed"),
    canceled: w("state_canceled"),
  };
}

const PROJECT_CATEGORY: Record<ProjectState, StatusCategory> = { backlog: "backlog", planned: "unstarted", started: "started", paused: "started", completed: "completed", canceled: "canceled" };
const PROJECT_COLOR: Record<ProjectState, string> = { backlog: "#95959f", planned: "#bec2c8", started: "#f2c94c", paused: "#e2a03f", completed: "#5e6ad2", canceled: "#95a2b3" };

// ------------------------------------------------------------ Documents

interface DocRow {
  note_id: string;
  parent_id: string | null;
  kind: string;
  title: string;
  icon: string;
  flags: number;
  trashed_at: number | null;
  updated_at: number;
}

function docRows(ws: string, ids: string[]): Map<string, DocRow> {
  const rows = sql("SELECT note_id, parent_id, kind, title, icon, flags, trashed_at, updated_at FROM eco_docs WHERE ws_id = ? AND note_id IN (SELECT value FROM json_each(?))").all(ws, JSON.stringify(ids)) as unknown as DocRow[];
  return new Map(rows.map((r) => [r.note_id, r]));
}

/**
 * A catalog-shaped row read straight from a note (title, icon, parent, trash) —
 * no writes, and only these fields: SQLite picks them out of the JSON, so a
 * 2 MB page costs what its title does.
 */
function rowFromNote(ws: string, id: string): DocRow | null {
  const r = sql(
    `SELECT json_extract(json, '$.kind') AS kind, json_extract(json, '$.title') AS title, json_extract(json, '$.icon') AS icon,
            json_extract(json, '$.parentId') AS parent, json_extract(json, '$.trashedAt') AS trashed, json_extract(json, '$.updatedAt') AS updated,
            json_extract(json, '$.template') AS template, json_extract(json, '$.synced') AS synced
     FROM notes WHERE ws = ? AND id = ? AND deleted = 0 AND json_valid(json)`
  ).get(ws, id) as { kind: string | null; title: string | null; icon: string | null; parent: string | null; trashed: number | null; updated: number | null; template: number | null; synced: number | null } | undefined;
  if (!r) return null;
  return {
    note_id: id,
    parent_id: typeof r.parent === "string" ? r.parent : null,
    kind: r.kind === "database" ? "database" : "page",
    title: typeof r.title === "string" ? r.title : "",
    icon: typeof r.icon === "string" ? r.icon : "",
    flags: r.template || r.synced ? 2 : 0,
    trashed_at: typeof r.trashed === "number" ? r.trashed : null,
    updated_at: Number(r.updated) || 0,
  };
}

/** Notes that do not exist (deleted, never synced), remembered for a minute: a page full of links to them stays cheap. */
const missingNotes = new Map<string, number>();
function knownMissing(ws: string, id: string): boolean {
  const at = missingNotes.get(`${ws}|${id}`);
  return at !== undefined && Date.now() - at < 60_000;
}
function rememberMissing(ws: string, id: string): void {
  missingNotes.set(`${ws}|${id}`, Date.now());
  if (missingNotes.size > 20_000) missingNotes.clear();
}

function noteCards(v: Viewer, ids: string[]): Map<string, Card> {
  const out = new Map<string, Card>();
  if (!ids.length) return out;
  const rows = docRows(v.wsId, ids);
  // Not in the catalog yet (just saved; the indexer is a moment behind): read from Documents
  // itself, without writing anything, and ask the indexer to catch up. Notes that do not exist
  // (deleted, never synced) are remembered for a minute so they cost nothing on every refresh.
  const missing = ids.filter((id) => !rows.has(id) && !knownMissing(v.wsId, id));
  if (missing.length) {
    const found: string[] = [];
    for (const id of missing.slice(0, 20)) {
      const row = rowFromNote(v.wsId, id);
      if (row) {
        rows.set(id, row);
        found.push(id);
      } else rememberMissing(v.wsId, id);
    }
    if (found.length) requestIndex(v.wsId, found);
  }
  // Parents, for the trash check and the second line.
  const known = new Map(rows);
  const lookup = (id: string): DocRow | undefined => {
    if (!known.has(id)) {
      const r = docRows(v.wsId, [id]).get(id) ?? rowFromNote(v.wsId, id) ?? undefined;
      if (r) known.set(id, r);
    }
    return known.get(id);
  };
  const l = words(v.locale);
  // Documents' own access (Private pages, teamspaces, pages shared with some people only).
  const acc = new AccessResolver(v.wsId, v.userId);
  for (const id of ids) {
    const r = rows.get(id);
    if (!r || r.flags & 2) continue;
    if (acc.level(id) === null) continue;
    let trashed = false;
    let cur: DocRow | undefined = r;
    for (let depth = 0; cur && depth < 100; depth++) {
      if (cur.trashed_at !== null) {
        trashed = true;
        break;
      }
      cur = cur.parent_id ? lookup(cur.parent_id) : undefined;
    }
    if (trashed) continue;
    // The second line names the parent only to someone who may open it (a private parent's title is not theirs).
    const parent = r.parent_id && acc.level(r.parent_id) !== null ? lookup(r.parent_id) : undefined;
    const title = displayTitle({ title: r.title }, l.untitled);
    out.set(`note:${id}`, {
      key: `note:${id}`,
      kind: "note",
      title,
      icon: r.icon || undefined,
      url: refHref({ kind: "note", id }, v.wsId, { slug: noteSlug({ id, title: r.title }) }),
      sub: parent ? (r.flags & 1 ? `${l.row} ${displayTitle({ title: parent.title }, l.untitled)}` : displayTitle({ title: parent.title }, l.untitled)) : undefined,
      updatedAt: r.updated_at,
    });
  }
  return out;
}

// ------------------------------------------------------------ Projects

/** Display names of these people (one query; never the whole directory). */
export function namesOf(ids: string[]): Map<string, string> {
  if (!ids.length) return new Map();
  const rows = sql("SELECT id, name FROM users WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify([...new Set(ids)])) as { id: string; name: string }[];
  return new Map(rows.map((r) => [r.id, r.name]));
}

function projectsCtx(v: Viewer): Ctx | null {
  try {
    return ctxFor(v.userId, v.wsId, "read");
  } catch {
    return null;
  }
}

function issueCards(v: Viewer, ctx: Ctx, ids: string[]): Map<string, Card> {
  const out = new Map<string, Card>();
  if (!ids.length) return out;
  const issues = issuesByIds(ctx, ids);
  if (!issues.length) return out;
  const all = listStatuses(ctx);
  const statuses = new Map(all.map((s) => [s.id, s]));
  const names = namesOf(issues.map((i) => i.assigneeId).filter((x): x is string => Boolean(x)));
  for (const i of issues) {
    if (i.archivedAt) continue;
    const s = statuses.get(i.statusId);
    out.set(`issue:${i.id}`, {
      key: `issue:${i.id}`,
      kind: "issue",
      title: i.title,
      url: refHref({ kind: "issue", id: i.id }, v.wsId, { ident: i.identifier }),
      sub: i.identifier,
      status: s ? { id: s.id, name: s.name, color: s.color, category: s.category, fraction: statusFraction(all, s.id) } : undefined,
      assignee: i.assigneeId ? { id: i.assigneeId, name: names.get(i.assigneeId) ?? "" } : null,
      due: i.dueDate,
      priority: i.priority,
      updatedAt: i.updatedAt,
    });
  }
  return out;
}

function projectCards(v: Viewer, ctx: Ctx, ids: string[]): Map<string, Card> {
  const out = new Map<string, Card>();
  if (!ids.length) return out;
  const want = new Set(ids);
  const l = words(v.locale);
  for (const p of listProjects(ctx)) {
    if (!want.has(p.id) || p.archivedAt) continue;
    const total = p.progress.total;
    out.set(`project:${p.id}`, {
      key: `project:${p.id}`,
      kind: "project",
      title: p.name,
      icon: p.icon ?? undefined,
      color: p.color,
      url: refHref({ kind: "project", id: p.id }, v.wsId),
      sub: p.summary || undefined,
      status: { name: l[p.state], color: PROJECT_COLOR[p.state], category: PROJECT_CATEGORY[p.state] },
      progress: total ? p.progress.completed / total : 0,
      updatedAt: p.updatedAt,
    });
  }
  return out;
}

// ------------------------------------------------------------ Design

type Frames = Awaited<ReturnType<typeof fileFrames>>;
const fileCache = new Map<string, { at: number; value: Frames | null }>();

/** Penpot lookups per person per minute (each reads a whole file): past it, cards of designs wait for the cache. */
const DESIGN_LOOKUPS_PER_MINUTE = 60;
const lookups = new Map<string, { since: number; n: number }>();

function mayLookUp(userId: string): boolean {
  const now = Date.now();
  let b = lookups.get(userId);
  if (!b || now - b.since > 60_000) lookups.set(userId, (b = { since: now, n: 0 }));
  if (lookups.size > 5000) lookups.clear();
  return ++b.n <= DESIGN_LOOKUPS_PER_MINUTE;
}

const inFlight = new Map<string, Promise<Frames | null>>();
/** An interactive read waits this long for Design, then shows what it last knew. */
const DESIGN_WAIT_MS = 3000;

async function framesOf(userId: string, file: string): Promise<Frames | null> {
  const k = `${userId}|${file}`;
  const hit = fileCache.get(k);
  if (hit && Date.now() - hit.at < 15_000) return hit.value;
  if (!mayLookUp(userId)) return hit?.value ?? null;
  let p = inFlight.get(k);
  if (!p) {
    p = fileFrames(userId, file)
      .then((value) => {
        fileCache.set(k, { at: Date.now(), value });
        if (fileCache.size > 2000) fileCache.clear();
        return value as Frames | null;
      })
      // Design down: the last good answer stands (a card does not vanish because of an outage).
      .catch(() => hit?.value ?? null)
      .finally(() => inFlight.delete(k));
    inFlight.set(k, p);
  }
  const late = new Promise<Frames | null>((r) => setTimeout(() => r(hit?.value ?? null), DESIGN_WAIT_MS).unref?.());
  return Promise.race([p, late]);
}

async function designCards(v: Viewer, refs: Extract<Ref, { kind: "design" }>[]): Promise<Map<string, Card>> {
  const out = new Map<string, Card>();
  if (!refs.length || !designConfigured()) return out;
  const team = (sql("SELECT penpot_team_id FROM workspaces WHERE id = ?").get(v.wsId) as { penpot_team_id: string | null } | undefined)?.penpot_team_id;
  if (!team) return out;
  const l = words(v.locale);
  // A request names at most 10 design files (each is a whole-file read in Design).
  const files = [...new Set(refs.map((r) => r.file))].slice(0, 10);
  const byFile = new Map(await Promise.all(files.map(async (f) => [f, await framesOf(v.userId, f)] as const)));
  for (const r of refs) {
    const f = byFile.get(r.file);
    // Only the workspace's own designs: a file of another team is not shown here.
    if (!f || f.teamId !== team) continue;
    const key = refKey(r);
    const frame = r.frame ? f.frames.find((x) => x.id === r.frame) : undefined;
    if (r.frame && !frame) continue;
    out.set(key, {
      key,
      kind: "design",
      title: frame ? frame.name || l.frame : f.name || l.design,
      url: refHref(r, v.wsId),
      sub: frame ? `${f.name} · ${frame.pageName}` : l.design,
      image: frame ? `/api/design/frame-image?ws=${encodeURIComponent(v.wsId)}&file=${r.file}&frame=${frame.id}&v=${f.revn}` : undefined,
    });
  }
  return out;
}

// ------------------------------------------------------------ people

function userCards(v: Viewer, ids: string[]): Map<string, Card> {
  const out = new Map<string, Card>();
  if (!ids.length) return out;
  const rows = sql("SELECT u.id, u.name FROM users u JOIN members m ON m.user_id = u.id AND m.ws_id = ? WHERE u.id IN (SELECT value FROM json_each(?))").all(v.wsId, JSON.stringify(ids)) as { id: string; name: string }[];
  for (const r of rows) out.set(`user:${r.id}`, { key: `user:${r.id}`, kind: "user", title: r.name, url: refHref({ kind: "user", id: r.id }, v.wsId) });
  return out;
}

// ------------------------------------------------------------ Mail

/**
 * Mail is personal: a conversation's card goes to its owner and nobody else,
 * whichever workspace asks (a link to it in a shared page, the Related panel
 * of an issue made from it). Anyone else gets no card, so they never learn it
 * exists.
 */
function mailCards(v: Viewer, ids: string[]): Map<string, Card> {
  const out = new Map<string, Card>();
  if (!ids.length) return out;
  for (const t of threadBriefs(v.userId, ids)) {
    const key = `mail:${t.id}`;
    out.set(key, { key, kind: "mail", title: t.subject || ecoText(v.locale, "untitled"), url: refHref({ kind: "mail", id: t.id }, v.wsId), sub: t.from, updatedAt: t.at });
  }
  return out;
}

// ------------------------------------------------------------ all kinds

/** Cards for the keys this person may see, in the order asked (unknown and hidden keys are left out). */
export async function cardsFor(v: Viewer, keys: readonly string[]): Promise<Card[]> {
  ecoDb();
  const refs = [...new Set(keys)].slice(0, 300).map(parseRefKey).filter((r): r is Ref => r !== null);
  const ids = (kind: "note" | "issue" | "project" | "user" | "event" | "mail") => refs.filter((r): r is Extract<Ref, { kind: typeof kind }> => r.kind === kind).map((r) => (r as { id: string }).id);
  const all = new Map<string, Card>();
  for (const [k, c] of noteCards(v, ids("note"))) all.set(k, c);
  for (const [k, c] of userCards(v, ids("user"))) all.set(k, c);
  // Calendar events: by the rule of their calendar (lib/calendar/access.ts).
  for (const [k, c] of eventCards(v, ids("event"))) all.set(k, c);
  for (const [k, c] of mailCards(v, ids("mail"))) all.set(k, c);
  const issueIds = ids("issue");
  const projectIds = ids("project");
  if (issueIds.length || projectIds.length) {
    const ctx = projectsCtx(v);
    if (ctx) {
      for (const [k, c] of issueCards(v, ctx, issueIds)) all.set(k, c);
      for (const [k, c] of projectCards(v, ctx, projectIds)) all.set(k, c);
    }
  }
  const designs = refs.filter((r): r is Extract<Ref, { kind: "design" }> => r.kind === "design");
  for (const [k, c] of await designCards(v, designs)) all.set(k, c);
  return refs.map((r) => all.get(refKey(r))).filter((c): c is Card => Boolean(c));
}
