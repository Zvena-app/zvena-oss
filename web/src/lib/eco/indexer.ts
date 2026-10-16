// The indexer: keeps the ecosystem's links and the Documents catalog in step
// with the products. Server-only.
//
// It hears every workspace's pulse (lib/pulse/bus.ts). A poke names what
// changed; the indexer reads that object through its product's own storage,
// extracts what it points at (lib/eco/extract.ts) and rewrites its links.
// Products need not know about it: anything that is saved is announced, and
// anything announced is indexed.
//
// Work is queued and done in small slices on later ticks, so a burst of
// saves never holds up the requests that made them. A workspace seen for the
// first time (or after INDEX_VERSION changes) is indexed whole, in the
// background; until then its "Related" panels say they are still filling.

import { createHash } from "node:crypto";
import { config } from "../config";
import { blocksText } from "../notes/model";
import type { DbSchema, Note } from "../notes/types";
import { ctxFor, type Ctx } from "../projects/core";
import { issueDescription, resolveIssueId } from "../projects/issues";
import { getProject } from "../projects/planning";
import { commentsOf } from "../projects/social";
import { refsInMarkdown, refsInNote, type Found } from "./extract";
import { dropObject, dropParts, setDerived, type DerivedVia } from "./links";
import { listenAll, type PulseEvent } from "../pulse/bus";
import { startGlue } from "./glue";
import { refKey, type Origins, type Ref } from "./refs";
import { ecoDb, INDEX_VERSION } from "./schema";
import { sql, tx } from "../store";

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export function origins(): Origins {
  let design: string | undefined;
  try {
    design = config.designUrl || undefined;
  } catch {
    design = undefined;
  }
  return { app: config.appUrl, design };
}

// ------------------------------------------------------------ workspaces

interface WsInfo {
  ownerId: string;
}

const wsCache = new Map<string, { info: WsInfo | null; at: number }>();

/** A workspace that exists (guests' documents have none: they are not indexed). */
function wsInfo(ws: string): WsInfo | null {
  const hit = wsCache.get(ws);
  if (hit && Date.now() - hit.at < 60_000) return hit.info;
  const r = sql("SELECT owner_id FROM workspaces WHERE id = ?").get(ws) as { owner_id: string } | undefined;
  const info = r ? { ownerId: r.owner_id } : null;
  wsCache.set(ws, { info, at: Date.now() });
  if (wsCache.size > 5000) wsCache.clear();
  return info;
}

/** The indexer reads as the workspace owner: links are facts of the workspace; who may see them is checked when they are shown. */
export function systemCtx(ws: string): Ctx | null {
  const info = wsInfo(ws);
  if (!info) return null;
  try {
    return ctxFor(info.ownerId, ws, "read");
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ resolving

/**
 * Turns what a link names into a ref of this workspace, or null when it names
 * nothing here. Ids are kept as written (the object may arrive in the next
 * part of a big save; a card shows nothing for what is missing or hidden).
 * KEY-12 is read as the person who wrote it, so text cannot reach into a team
 * its writer cannot see; a link copied from another workspace names nothing.
 */
function resolve(ws: string, f: Found, ctx: Ctx | null): Ref | null {
  const r = f.raw;
  switch (r.kind) {
    case "note":
    case "issue":
    case "project":
    case "event":
      return r;
    case "note-share": {
      const s = sql("SELECT note_id FROM note_shares WHERE id = ? AND ws = ?").get(r.id, ws) as { note_id: string } | undefined;
      return s ? { kind: "note", id: s.note_id } : null;
    }
    case "issue-ident":
      if (!ctx || (r.ws && r.ws !== ws)) return null;
      try {
        return { kind: "issue", id: resolveIssueId(ctx, r.ident) };
      } catch {
        return null;
      }
    case "design":
      // Design files live in Design's own database; a link to one is kept as written.
      return r;
    case "user":
      return sql("SELECT 1 FROM members WHERE ws_id = ? AND user_id = ?").get(ws, r.id) ? r : null;
    case "mail":
      // A pasted Mail link is kept as written: its card shows to the conversation's owner only.
      return r;
  }
}

/** Projects' view of the person who wrote a text (a member), else the workspace's. */
function writerCtx(ws: string, by: string | undefined | null): Ctx | null {
  if (by && /^[A-Za-z0-9_-]{6,64}$/.test(by)) {
    try {
      return ctxFor(by, ws, "read");
    } catch {
      // Not a member (any more): read as the workspace.
    }
  }
  return systemCtx(ws);
}

/** What found links name, as link targets of this workspace (unknown and foreign ones dropped). */
export function resolveTargets(ws: string, found: Found[], ctx: Ctx | null): { dst: string; via: DerivedVia }[] {
  const out: { dst: string; via: DerivedVia }[] = [];
  for (const f of found) {
    const ref = resolve(ws, f, ctx);
    if (ref) out.push({ dst: refKey(ref), via: f.via });
  }
  return out;
}

// ------------------------------------------------------------ Documents

const FLAG_ROW = 1;
const FLAG_HIDDEN = 2;

function readNote(ws: string, id: string): Note | null {
  const r = sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, id) as { json: string | null } | undefined;
  if (!r?.json) return null;
  try {
    const n = JSON.parse(r.json) as Note;
    return n && typeof n === "object" && n.id === id ? n : null;
  } catch {
    return null;
  }
}

/** A short fingerprint of a text (unchanged text is never rewritten). */
function fingerprint(...parts: string[]): string {
  const h = createHash("sha1");
  for (const p of parts) h.update(p).update("\u0000");
  return h.digest("base64url");
}

/** A row's values as text for search: option names, not their ids. */
function rowText(props: Note["props"], schema: DbSchema | null): string {
  if (!props) return "";
  const parts: string[] = [];
  for (const [id, v] of Object.entries(props)) {
    const p = schema?.properties.find((x) => x.id === id);
    const name = (o: unknown) => (typeof o === "string" ? (p?.options?.find((x) => x.id === o)?.name ?? (p ? "" : o)) : "");
    if (p && (p.type === "select" || p.type === "status")) parts.push(name(v));
    else if (p && p.type === "multi_select" && Array.isArray(v)) parts.push(v.map(name).join(" "));
    else if (typeof v === "string" && v.length < 2000 && (!p || p.type === "text" || p.type === "title" || p.type === "url" || p.type === "email" || p.type === "phone")) parts.push(v);
  }
  return parts.filter(Boolean).join(" ");
}

/**
 * Reads one note and brings its catalog entry, search text and links up to
 * date. `quiet` (a backfill): no pokes — nothing is open on objects being
 * indexed for the first time.
 */
export function indexNote(ws: string, id: string, schemas = new Map<string, DbSchema | null>(), by?: string | null, quiet = false): void {
  if (!ID_RE.test(id) || !wsInfo(ws)) return;
  ecoDb();
  const n = readNote(ws, id);
  const key = `note:${id}`;
  if (!n) {
    sql("DELETE FROM eco_docs WHERE ws_id = ? AND note_id = ?").run(ws, id);
    sql("DELETE FROM eco_parts WHERE ws_id = ? AND src = ?").run(ws, key);
    dropObject(ws, key);
    return;
  }
  const meta = sql("SELECT stamp, updated_by FROM notes WHERE ws = ? AND id = ?").get(ws, id) as { stamp: number; updated_by: string | null } | undefined;
  // A row's relation properties are named by its database's schema.
  let schema: DbSchema | null = null;
  if (n.parentId && n.props) {
    if (!schemas.has(n.parentId)) {
      const parent = readNote(ws, n.parentId);
      schemas.set(n.parentId, parent?.kind === "database" ? (parent.db ?? null) : null);
    }
    schema = schemas.get(n.parentId) ?? null;
  }
  // A database's further data source (a database note under it) is not one of its rows.
  const isRow = !(n.kind === "database" && n.db?.dataSource === true) && (Boolean(schema) || (n.parentId ? (sql("SELECT kind FROM eco_docs WHERE ws_id = ? AND note_id = ?").get(ws, n.parentId) as { kind: string } | undefined)?.kind === "database" : false));
  const flags = (isRow ? FLAG_ROW : 0) | (n.template || n.synced ? FLAG_HIDDEN : 0);
  // A database: which of its properties link rows to things (relations, people). When that
  // changes (a relation property removed), its rows are indexed again.
  const sig =
    n.kind === "database"
      ? (n.db?.properties ?? [])
          .filter((p) => p.type === "relation" || (p.type as string) === "person")
          .map((p) => `${p.type}:${p.id}`)
          .sort()
          .join(",")
      : "";
  const before = sql("SELECT sig, text_hash FROM eco_docs WHERE ws_id = ? AND note_id = ?").get(ws, id) as { sig: string; text_hash: string } | undefined;
  const title = typeof n.title === "string" ? n.title.slice(0, 2000) : "";
  const body = `${blocksText(n.content, 0, 100_000)}\n${rowText(n.props, schema)}`.slice(0, 120_000);
  const textHash = fingerprint(title, body);
  tx(() => {
    const row = sql(
      `INSERT INTO eco_docs (ws_id, note_id, parent_id, kind, title, icon, flags, trashed_at, updated_at, sig, text_hash, stamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ws_id, note_id) DO UPDATE SET parent_id = excluded.parent_id, kind = excluded.kind, title = excluded.title, icon = excluded.icon,
         flags = excluded.flags, trashed_at = excluded.trashed_at, updated_at = excluded.updated_at, sig = excluded.sig, text_hash = excluded.text_hash, stamp = excluded.stamp
       RETURNING fts_id`
    ).get(ws, id, n.parentId ?? null, n.kind === "database" ? "database" : "page", title, typeof n.icon === "string" ? n.icon.slice(0, 200) : "", flags, n.trashedAt ?? null, Number(n.updatedAt) || Date.now(), sig, textHash, meta?.stamp ?? 0) as { fts_id: number };
    // The search text is rewritten only when it changed (a big page saved while someone types).
    if (before?.text_hash !== textHash) {
      sql("DELETE FROM eco_search WHERE rowid = ?").run(row.fts_id);
      sql("INSERT INTO eco_search (rowid, ws, title, body) VALUES (?, ?, ?, ?)").run(row.fts_id, ws, title, body);
    }
  });
  if (before && before.sig !== sig) {
    const rows = (sql("SELECT note_id FROM eco_docs WHERE ws_id = ? AND parent_id = ?").all(ws, id) as { note_id: string }[]).map((r) => r.note_id);
    if (rows.length) enqueue(ws, "notes", rows);
  }
  const relationProps = (schema?.properties ?? []).filter((p) => p.type === "relation").map((p) => p.id);
  // Person properties (Documents' "person" type: user ids).
  const personProps = (schema?.properties ?? []).filter((p) => (p.type as string) === "person").map((p) => p.id);
  // The links come from the blocks and the link-bearing values: unchanged, nothing to do.
  const linkHash = fingerprint(JSON.stringify(n.content ?? []), JSON.stringify(relationProps.map((p) => n.props?.[p] ?? null)), JSON.stringify(personProps.map((p) => n.props?.[p] ?? null)));
  if (unchangedPart(ws, key, "", linkHash)) return;
  const found = refsInNote(n, origins(), relationProps, personProps);
  const needsCtx = found.some((f) => f.raw.kind === "issue-ident");
  setDerived(ws, key, "", resolveTargets(ws, found, needsCtx ? writerCtx(ws, by ?? meta?.updated_by) : null), null, quiet);
  rememberPart(ws, key, "", linkHash);
}

/** True when this part of an object was already indexed from exactly this text. */
function unchangedPart(ws: string, src: string, part: string, hash: string): boolean {
  return (sql("SELECT hash FROM eco_parts WHERE ws_id = ? AND src = ? AND part = ?").get(ws, src, part) as { hash: string } | undefined)?.hash === hash;
}

function rememberPart(ws: string, src: string, part: string, hash: string): void {
  sql("INSERT INTO eco_parts (ws_id, src, part, hash) VALUES (?, ?, ?, ?) ON CONFLICT(ws_id, src, part) DO UPDATE SET hash = excluded.hash").run(ws, src, part, hash);
}

// ------------------------------------------------------------ Projects

/** Reads one issue (description and comments) and rewrites its links. */
export function indexIssue(ws: string, id: string): boolean {
  const ctx = systemCtx(ws);
  if (!ctx || !ID_RE.test(id)) return false;
  ecoDb();
  const key = `issue:${id}`;
  if (!sql("SELECT 1 FROM pj_issues WHERE id = ? AND ws_id = ?").get(id, ws)) return false;
  let description = "";
  try {
    description = issueDescription(ctx, id);
  } catch {
    return false;
  }
  const o = origins();
  // Each part (the description, each comment) is read again only when its text changed.
  const dh = fingerprint(description);
  if (!unchangedPart(ws, key, "", dh)) {
    setDerived(ws, key, "", resolveTargets(ws, refsInMarkdown(description, o), ctx));
    rememberPart(ws, key, "", dh);
  }
  const parts = [""];
  for (const c of commentsOf(id)) {
    const part = `c:${c.id}`;
    parts.push(part);
    const h = fingerprint(c.body, c.authorId ?? "");
    if (unchangedPart(ws, key, part, h)) continue;
    setDerived(ws, key, part, resolveTargets(ws, refsInMarkdown(c.body, o), writerCtx(ws, c.authorId)));
    rememberPart(ws, key, part, h);
  }
  dropParts(ws, key, parts);
  sql("DELETE FROM eco_parts WHERE ws_id = ? AND src = ? AND part NOT IN (SELECT value FROM json_each(?))").run(ws, key, JSON.stringify(parts));
  return true;
}

/** Reads one project (its description) and rewrites its links. */
export function indexProject(ws: string, id: string): boolean {
  const ctx = systemCtx(ws);
  if (!ctx || !ID_RE.test(id)) return false;
  if (!sql("SELECT 1 FROM pj_projects WHERE id = ? AND ws_id = ?").get(id, ws)) return false;
  try {
    const p = getProject(ctx, id);
    setDerived(ws, `project:${id}`, "", resolveTargets(ws, refsInMarkdown(p.description, origins()), ctx));
    return true;
  } catch {
    return false;
  }
}

/** Projects entities whose text can link to things (the rest — teams, views, labels… — cannot). */
const LINKING = new Set(["issue", "comment", "project"]);

/** A Projects poke names an issue or a project (or something under one); whichever it is gets indexed. */
function indexProjectsRef(ws: string, ref: string): void {
  if (indexIssue(ws, ref) || indexProject(ws, ref)) return;
  // Gone (or never an issue/project): links from and to it that people made go too.
  const issueGone = !sql("SELECT 1 FROM pj_issues WHERE id = ?").get(ref);
  const projectGone = !sql("SELECT 1 FROM pj_projects WHERE id = ?").get(ref);
  if (issueGone && hasLinks(ws, `issue:${ref}`)) dropObject(ws, `issue:${ref}`);
  if (projectGone && hasLinks(ws, `project:${ref}`)) dropObject(ws, `project:${ref}`);
}

function hasLinks(ws: string, key: string): boolean {
  // Two index lookups (an OR over src/dst would scan the workspace's links).
  const r = sql("SELECT EXISTS (SELECT 1 FROM eco_links WHERE ws_id = ? AND src = ?) OR EXISTS (SELECT 1 FROM eco_links WHERE ws_id = ? AND dst = ?) AS x").get(ws, key, ws, key) as { x: number };
  return Boolean(r.x);
}

// ------------------------------------------------------------ the queue

interface State {
  started: boolean;
  queue: Map<string, Map<string, string | undefined>>; // "<ws>|notes" / "<ws>|projects" → id → who wrote it
  timer: ReturnType<typeof setTimeout> | null;
  backfill: Set<string>;
  backfilling: boolean;
  sweeping: boolean;
  sweepTimer: ReturnType<typeof setInterval> | null;
  stop: (() => void) | null;
}

const KEY = Symbol.for("zvena.eco.indexer");
const g = globalThis as unknown as Record<symbol, State | undefined>;
const st: State = (g[KEY] ??= { started: false, queue: new Map(), timer: null, backfill: new Set(), backfilling: false, sweeping: false, sweepTimer: null, stop: null });

/** How often every workspace catches up with what its pokes may have missed. */
const SWEEP_EVERY = 5 * 60_000;

const SLICE = 40;
/** At most this long per slice of work (then the event loop serves requests). */
const SLICE_MS = 12;

function enqueue(ws: string, kind: "notes" | "projects", ids: string[], by?: string): void {
  const k = `${ws}|${kind}`;
  let m = st.queue.get(k);
  if (!m) st.queue.set(k, (m = new Map()));
  for (const id of ids) if (ID_RE.test(id)) m.set(id, by);
  // Notes are saved every second or so while someone types: a short pause coalesces them.
  schedule(kind === "notes" ? NOTES_DELAY : 25);
}

const NOTES_DELAY = 600;

/** Notes a reader found missing from the catalog: indexed soon, in the background. */
export function requestIndex(ws: string, ids: string[]): void {
  enqueue(ws, "notes", ids);
}

function schedule(delay = 25): void {
  if (st.timer) return;
  st.timer = setTimeout(drain, delay);
  // A pending slice never keeps a test process or a shutting-down server alive.
  (st.timer as { unref?: () => void }).unref?.();
}

function drain(): void {
  st.timer = null;
  let done = 0;
  const until = Date.now() + SLICE_MS;
  const schemas = new Map<string, DbSchema | null>();
  for (const [k, ids] of st.queue) {
    const [ws, kind] = k.split("|");
    for (const [id, by] of ids) {
      ids.delete(id);
      try {
        if (kind === "notes") indexNote(ws, id, schemas, by);
        else indexProjectsRef(ws, id);
      } catch {
        // One broken object never stops the others.
      }
      if (++done >= SLICE || Date.now() > until) break;
    }
    if (ids.size === 0) st.queue.delete(k);
    if (done >= SLICE || Date.now() > until) break;
  }
  if (st.queue.size) schedule(5);
}

/** Design files whose comments may have changed: indexed a moment later, once per burst. */
const designQueue = new Map<string, { t: ReturnType<typeof setTimeout>; at: number }>();
/** A comment event is indexed soon; any other change of the file (which may hide a comment
 *  event merged into it by the sender's throttling) at most this often. */
const DESIGN_SOON = 1500;
const DESIGN_LATER = 20_000;

function onDesign(e: PulseEvent): void {
  if (!e.ref) return;
  const soon = /comment/.test(String(e.data?.event ?? ""));
  const k = `${e.ws}|${e.ref}`;
  const due = Date.now() + (soon ? DESIGN_SOON : DESIGN_LATER);
  const prev = designQueue.get(k);
  // Keep the earlier of the two: a comment never waits behind a slow re-check.
  if (prev && prev.at <= due) return;
  if (prev) clearTimeout(prev.t);
  const t = setTimeout(() => {
    designQueue.delete(k);
    void import("./design").then((m) => m.indexDesignFile(e.ws, e.ref as string)).catch(() => undefined);
  }, due - Date.now());
  (t as { unref?: () => void }).unref?.();
  designQueue.set(k, { t, at: due });
}

/** An issue made from a Design comment moved: its thread follows (resolved when closed, reopened when opened). */
function followThread(e: PulseEvent): void {
  const issueId = e.ref;
  if (!issueId || e.data?.deleted === true) return;
  try {
    if (!sql("SELECT 1 FROM eco_design_threads WHERE ws_id = ? AND issue_id = ?").get(e.ws, issueId)) return;
  } catch {
    return;
  }
  void import("./design").then((m) => m.followIssueForThread(e.ws, issueId, e.by)).catch(() => {});
}

function onPulse(e: PulseEvent): void {
  if (e.type === "design") return onDesign(e);
  if (e.type !== "notes" && e.type !== "projects") return;
  const entity = e.data?.entity;
  if (e.type === "projects" && (entity === undefined || entity === "issue")) followThread(e);
  if (e.type === "projects" && typeof entity === "string" && !LINKING.has(entity)) return;
  const ids = e.refs ?? (e.ref ? [e.ref] : []);
  if (ids.length) enqueue(e.ws, e.type, ids, e.by);
}

/** Starts hearing the pulse (once per process; instrumentation.ts calls it at startup). */
export function startEco(): void {
  if (st.started) return;
  st.started = true;
  startGlue();
  st.stop = listenAll(onPulse);
  st.sweepTimer = setInterval(() => void sweepAll(), SWEEP_EVERY);
  (st.sweepTimer as { unref?: () => void }).unref?.();
  // Workspaces not indexed yet (new ones, or after INDEX_VERSION changed) are filled in the background.
  setTimeout(() => {
    try {
      ecoDb();
      const rows = sql("SELECT w.id FROM workspaces w LEFT JOIN eco_index x ON x.ws_id = w.id WHERE x.version IS NULL OR x.version < ?").all(INDEX_VERSION) as { id: string }[];
      for (const r of rows) st.backfill.add(r.id);
      void runBackfill().then(() => sweepAll());
    } catch {
      // The store is not ready (a build step): requests start it later.
    }
  }, 2000).unref?.();
}

/** Stops hearing the pulse (tests). */
export function stopEco(): void {
  st.stop?.();
  st.stop = null;
  if (st.sweepTimer) clearInterval(st.sweepTimer);
  st.sweepTimer = null;
  st.started = false;
  // Pending work stays undone: nothing is indexed behind a stopped indexer's back.
  if (st.timer) clearTimeout(st.timer);
  st.timer = null;
  st.queue.clear();
}

const tick = () => new Promise<void>((r) => setImmediate(r));

async function backfillWs(ws: string, full = false): Promise<void> {
  if (!wsInfo(ws)) return;
  ecoDb();
  // Writes landing while this runs are newer than these marks: the next catch-up indexes them.
  const marks = {
    notes: Number((sql("SELECT COALESCE(MAX(stamp), 0) AS m FROM notes WHERE ws = ?").get(ws) as { m: number }).m),
    pj: Date.now() - 5_000,
  };
  // What is already indexed at its current stamp is skipped (a restarted backfill resumes);
  // databases first, so their rows read their schema from the catalog's neighbours.
  const order = (
    sql(
      `SELECT n.id FROM notes n LEFT JOIN eco_docs d ON d.ws_id = n.ws AND d.note_id = n.id
       WHERE n.ws = ? AND n.deleted = 0 AND (d.stamp IS NULL OR d.stamp != n.stamp OR ? = 1)
       ORDER BY n.stamp`
    ).all(ws, full ? 1 : 0) as { id: string }[]
  ).map((r) => r.id);
  const schemas = new Map<string, DbSchema | null>();
  let until = Date.now() + SLICE_MS;
  for (let i = 0; i < order.length; i++) {
    try {
      indexNote(ws, order[i], schemas, null, true);
    } catch {
      // Skipped; its next save indexes it.
    }
    if (Date.now() > until) {
      await tick();
      until = Date.now() + SLICE_MS;
    }
  }
  const issues = (sql("SELECT id FROM pj_issues WHERE ws_id = ?").all(ws) as { id: string }[]).map((r) => r.id);
  for (let i = 0; i < issues.length; i++) {
    try {
      indexIssue(ws, issues[i]);
    } catch {
      // Skipped.
    }
    if (Date.now() > until) {
      await tick();
      until = Date.now() + SLICE_MS;
    }
  }
  for (const r of sql("SELECT id FROM pj_projects WHERE ws_id = ?").all(ws) as { id: string }[]) {
    try {
      indexProject(ws, r.id);
    } catch {
      // Skipped.
    }
  }
  sql("INSERT INTO eco_index (ws_id, version, at, notes_stamp, pj_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(ws_id) DO UPDATE SET version = excluded.version, at = excluded.at, notes_stamp = excluded.notes_stamp, pj_at = excluded.pj_at").run(
    ws,
    INDEX_VERSION,
    Date.now(),
    marks.notes,
    marks.pj
  );
  prune(ws);
}

// ------------------------------------------------------------ catching up

/**
 * What changed since the workspace's high-water marks gets indexed: saves
 * whose poke was lost (a restart between the save and the indexer's next
 * slice) are found by their stamp, and so are notes deleted forever (their
 * tombstones keep a stamp). Then what is gone is pruned. Runs at start and
 * every few minutes; cheap when nothing is new.
 */
export async function catchUp(ws: string): Promise<void> {
  ecoDb();
  const mark = sql("SELECT notes_stamp, pj_at FROM eco_index WHERE ws_id = ?").get(ws) as { notes_stamp: number; pj_at: number } | undefined;
  if (!mark || !wsInfo(ws)) return;
  let notes = Number(mark.notes_stamp);
  const schemas = new Map<string, DbSchema | null>();
  for (let page = 0; page < 1000; page++) {
    const rows = sql("SELECT id, stamp FROM notes WHERE ws = ? AND stamp > ? ORDER BY stamp LIMIT 200").all(ws, notes) as { id: string; stamp: number }[];
    if (!rows.length) break;
    for (const r of rows) {
      try {
        indexNote(ws, r.id, schemas);
      } catch {
        // Skipped; its next save indexes it.
      }
    }
    notes = Number(rows[rows.length - 1].stamp);
    sql("UPDATE eco_index SET notes_stamp = ? WHERE ws_id = ?").run(notes, ws);
    await tick();
  }
  // Projects: issues (and their comments) and projects changed since the mark.
  const since = Number(mark.pj_at);
  const now = Date.now();
  const issues = sql(
    `SELECT id FROM pj_issues WHERE ws_id = ? AND updated_at > ?
     UNION SELECT issue_id FROM pj_comments WHERE ws_id = ? AND updated_at > ?`
  ).all(ws, since, ws, since) as { id: string }[];
  for (let i = 0; i < issues.length; i++) {
    try {
      indexIssue(ws, issues[i].id);
    } catch {
      // Skipped.
    }
    if (i % SLICE === SLICE - 1) await tick();
  }
  for (const r of sql("SELECT id FROM pj_projects WHERE ws_id = ? AND updated_at > ?").all(ws, since) as { id: string }[]) {
    try {
      indexProject(ws, r.id);
    } catch {
      // Skipped.
    }
  }
  // A little behind "now": a write committing at this very moment is seen next time.
  sql("UPDATE eco_index SET pj_at = ? WHERE ws_id = ?").run(now - 5_000, ws);
  prune(ws);
}

/** Objects that are gone for good lose their catalog entries and their links (whatever event was missed). */
export function prune(ws: string): number {
  ecoDb();
  let n = 0;
  n += Number(sql("DELETE FROM eco_docs WHERE ws_id = ? AND NOT EXISTS (SELECT 1 FROM notes WHERE notes.ws = eco_docs.ws_id AND notes.id = eco_docs.note_id AND notes.deleted = 0)").run(ws).changes);
  // Constant kinds and conditions only (no value is spliced into the SQL).
  const gone = (kind: "note" | "issue" | "project", exists: string) =>
    (
      sql(
        `SELECT k FROM (SELECT ws_id AS w, src AS k FROM eco_links WHERE ws_id = ? AND src > '${kind}:' AND src < '${kind};'
                        UNION SELECT ws_id, dst FROM eco_links WHERE ws_id = ? AND dst > '${kind}:' AND dst < '${kind};' AND via IN ('manual', 'converted'))
         WHERE NOT EXISTS (${exists})`
      ).all(ws, ws) as { k: string }[]
    ).map((r) => r.k);
  const lost = [
    ...gone("note", "SELECT 1 FROM notes WHERE notes.ws = w AND notes.id = substr(k, 6) AND notes.deleted = 0"),
    ...gone("issue", "SELECT 1 FROM pj_issues WHERE pj_issues.id = substr(k, 7)"),
    ...gone("project", "SELECT 1 FROM pj_projects WHERE pj_projects.id = substr(k, 9)"),
  ];
  for (const k of lost) dropObject(ws, k);
  n += lost.length;
  // Comments of issues that are gone.
  const parts = sql(
    `SELECT DISTINCT src, part FROM eco_links WHERE ws_id = ? AND src > 'issue:' AND src < 'issue;' AND part LIKE 'c:%'
       AND NOT EXISTS (SELECT 1 FROM pj_comments WHERE pj_comments.id = substr(part, 3))`
  ).all(ws) as { src: string; part: string }[];
  for (const p of parts) setDerived(ws, p.src, p.part, []);
  return n + parts.length;
}

/** Every indexed workspace, one after another, without holding up requests. */
async function sweepAll(): Promise<void> {
  if (st.sweeping) return;
  st.sweeping = true;
  try {
    ecoDb();
    const rows = sql("SELECT ws_id FROM eco_index WHERE version >= ?").all(INDEX_VERSION) as { ws_id: string }[];
    try {
      const { purgeInbox } = await import("./inbox");
      purgeInbox();
    } catch {
      // Next sweep.
    }
    for (const r of rows) {
      // Stopped meanwhile (tests, shutdown): the sweep ends with it.
      if (!st.started) break;
      try {
        await catchUp(r.ws_id);
      } catch {
        // Tried again on the next sweep.
      }
      await tick();
    }
  } finally {
    st.sweeping = false;
  }
}

async function runBackfill(): Promise<void> {
  if (st.backfilling) return;
  st.backfilling = true;
  try {
    while (st.backfill.size) {
      const [ws] = st.backfill;
      try {
        await backfillWs(ws);
      } catch {
        // Tried again on the next request for it.
      }
      st.backfill.delete(ws);
      await tick();
    }
  } finally {
    st.backfilling = false;
  }
}

/** True when the workspace is fully indexed; otherwise indexing starts (in the background) and false is returned. */
export function ensureIndexed(ws: string): boolean {
  ecoDb();
  const r = sql("SELECT version FROM eco_index WHERE ws_id = ?").get(ws) as { version: number } | undefined;
  if (r && r.version >= INDEX_VERSION) return true;
  if (!wsInfo(ws)) return true;
  st.backfill.add(ws);
  void runBackfill();
  return false;
}

/** Indexes a workspace now, whole (tests, and the first request of a small workspace). */
export async function indexWorkspace(ws: string): Promise<void> {
  await backfillWs(ws, true);
}
