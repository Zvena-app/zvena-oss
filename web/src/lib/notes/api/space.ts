// Server-only: what one API request of an integration sees — the
// workspace's notes, limited to the pages connected to the integration and
// everything under them (Notion's model), plus lookups of blocks inside.

import { sql } from "../../store";
import type { Note } from "../types";
import type { Integration } from "./integrations";
import { AccessResolver, atLeast, subtreeOf } from "../access";
import type { AccessLevel } from "../types";
import { connectorsOf } from "./integrations";
import { annotateSchema, deniedColumns, stripRow } from "../column-perms";
import { isSourceNote } from "../model";

/**
 * Notion API 2025-09-03: databases hold data sources (lib/notes/sources.ts);
 * a request naming that version (or a later one) gets data source objects,
 * "data_source_id" page parents and the data_sources endpoints. Older
 * versions see every data source as a database of its own, as before.
 */
export const DATA_SOURCES_VERSION = "2025-09-03";
export const usesDataSources = (version: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(version) && version >= DATA_SOURCES_VERSION;

/** Notion ids are dashed UUIDs; ours are 32 hex characters (notes) or UUIDs (blocks). */
export function toUuid(id: string): string {
  return /^[a-f0-9]{32}$/i.test(id) ? `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`.toLowerCase() : id;
}

/** The forms an id may be stored in (as given, without dashes, with dashes). */
export function idForms(id: string): string[] {
  const out = new Set<string>([id]);
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) out.add(id.replace(/-/g, ""));
  if (/^[a-f0-9]{32}$/i.test(id)) out.add(toUuid(id));
  return [...out];
}

export interface RawBlock {
  id?: string;
  type?: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: RawBlock[];
}

export interface BlockHit {
  /** The page (or row) the block lives in. */
  note: Note;
  block: RawBlock;
  /** The block's parent block (null: top level of the page). */
  parent: RawBlock | null;
  /** The list holding the block, and its position there. */
  list: RawBlock[];
  index: number;
}

export class Space {
  readonly notes = new Map<string, Note>();
  /** Connected page → who connected it (the integration's ceiling below that page). */
  private readonly roots: Map<string, string>;
  private readonly memo = new Map<string, AccessLevel | null>();
  private readonly resolvers = new Map<string, AccessResolver>();
  /** The API version of the request (Notion-Version): which shapes the objects take. */
  version = "2022-06-28";

  constructor(
    readonly integration: Integration,
    notes: Iterable<Note>,
    roots: Map<string, string> | Iterable<string>
  ) {
    for (const n of notes) this.notes.set(n.id, n);
    // A bare list (tests): the integration sees connected subtrees whole, as the workspace owner would.
    this.roots = roots instanceof Map ? roots : new Map([...roots].map((id) => [id, ""]));
  }

  private levelFor(connector: string, id: string): AccessLevel | null {
    if (!connector) return "full";
    let r = this.resolvers.get(connector);
    if (!r) {
      r = new AccessResolver(this.integration.ws, connector);
      this.resolvers.set(connector, r);
    }
    return r.level(id);
  }

  /** The integration's workspace as stored now. */
  static load(integration: Integration): Space {
    const roots = connectorsOf(integration.id);
    const notes = loadScope(integration.ws, [...roots.keys()]);
    // Column permissions: an integration reads only the columns open to it (by default, all);
    // formulas and rollups over a hidden column are hidden too (lib/notes/column-perms.ts).
    const who = { id: `integration:${integration.id}`, groups: new Set<string>(), full: false };
    const dbs = new Map(notes.filter((n) => n.kind === "database").map((n) => [n.id, n]));
    const denied = new Map<string, Map<string, "view" | "edit">>();
    const deniedOf = (db: Note, depth = 0): Map<string, "view" | "edit"> => {
      let d = denied.get(db.id);
      if (!d) {
        d = deniedColumns(db.db, who, (id) => {
          const other = depth < 2 && id !== db.id ? dbs.get(id) : undefined;
          return other?.db ? { schema: other.db, denied: deniedOf(other, depth + 1) } : undefined;
        });
        if (depth === 0) denied.set(db.id, d);
      }
      return d;
    };
    const shown = notes.map((n) => {
      if (n.kind === "database" && n.db) {
        const d = deniedOf(n);
        return d.size ? annotateSchema(n, who, d) : n;
      }
      const db = n.parentId ? dbs.get(n.parentId) : undefined;
      return db?.db?.properties.some((p) => p.perms) ? stripRow(n, deniedOf(db)) : n;
    });
    return new Space(integration, shown, roots);
  }

  /**
   * The integration's level on a note: it, or a page above it, is connected,
   * capped by what the person who connected that page may do there (a
   * restricted sub-page they cannot open stays closed to the integration).
   */
  level(id: string): AccessLevel | null {
    if (this.memo.has(id)) return this.memo.get(id) ?? null;
    let cur = this.notes.get(id);
    let connector: string | undefined;
    for (let depth = 0; cur && depth < 200; depth++) {
      connector = this.roots.get(cur.id);
      if (connector !== undefined) break;
      cur = cur.parentId ? this.notes.get(cur.parentId) : undefined;
    }
    const level = connector === undefined || !this.notes.has(id) ? null : this.levelFor(connector, id);
    this.memo.set(id, level);
    return level;
  }

  /** Whether the integration may see the note. */
  canSee(id: string): boolean {
    return this.level(id) !== null;
  }

  /** Whether the integration may change the note (or add under it: a new note's parent). */
  canWrite(id: string): boolean {
    return atLeast(this.level(id), "edit");
  }

  /** A visible note by any id form (null: missing or not shared with the integration). */
  note(id: string): Note | null {
    for (const f of idForms(id)) {
      const n = this.notes.get(f);
      if (n && this.canSee(n.id)) return n;
    }
    return null;
  }

  /** Every note the integration may see. */
  visible(): Note[] {
    return [...this.notes.values()].filter((n) => this.canSee(n.id));
  }

  /** Whether the note or a page above it is in the trash (only a trashed subtree's root carries trashedAt). */
  inTrash(n: Note): boolean {
    let cur: Note | undefined = n;
    for (let depth = 0; cur && depth < 200; depth++) {
      if (cur.trashedAt !== null) return true;
      cur = cur.parentId ? this.notes.get(cur.parentId) : undefined;
    }
    return false;
  }

  /** A block inside a visible page, by id. */
  findBlock(id: string): BlockHit | null {
    const forms = new Set(idForms(id));
    for (const n of this.notes.values()) {
      if (!Array.isArray(n.content) || n.content.length === 0 || !this.canSee(n.id)) continue;
      const hit = findIn(n.content as RawBlock[], forms, null);
      if (hit) return { note: n, ...hit };
    }
    return null;
  }

  /** Rows of a database or data source (not templates, not its further data sources), in order. */
  rows(dbId: string): Note[] {
    return [...this.notes.values()].filter((n) => n.parentId === dbId && !n.template && !isSourceNote(n)).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  /** The database a data source belongs to (a further source's parent; a database is its own first source). */
  hostOf(n: Note): Note {
    const p = isSourceNote(n) && n.parentId ? this.notes.get(n.parentId) : undefined;
    return p?.kind === "database" ? p : n;
  }

  /** A database's data sources the integration may see: its own first, then the further ones in order. */
  sourcesOf(db: Note): Note[] {
    const kids = [...this.notes.values()].filter((n) => n.parentId === db.id && isSourceNote(n) && this.canSee(n.id) && !this.inTrash(n)).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
    return [db, ...kids];
  }

  /** Database templates (rows marked as templates). */
  children(id: string): Note[] {
    return [...this.notes.values()].filter((n) => n.parentId === id).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }
}

/**
 * What one request may need of the workspace, never all of it: the connected
 * pages with everything under them, the pages above them (a connected row's
 * database: its schema), and the databases their relations point to (two
 * steps, for column permissions of rollups). Anything else is invisible to the
 * integration anyway (Notion: a relation to a database not shared with it
 * reads empty).
 */
function loadScope(ws: string, roots: readonly string[]): Note[] {
  const out = new Map<string, Note>();
  const read = (ids: Iterable<string>) => {
    const want = [...ids].filter((id) => !out.has(id));
    for (let i = 0; i < want.length; i += 500) {
      const part = want.slice(i, i + 500);
      const rows = sql(`SELECT json FROM notes WHERE ws = ? AND deleted = 0 AND id IN (${part.map(() => "?").join(",")})`).all(ws, ...part) as { json: string | null }[];
      for (const r of rows) {
        try {
          const n = JSON.parse(r.json ?? "null") as Note | null;
          if (n && typeof n.id === "string") out.set(n.id, n);
        } catch {
          // A broken row is skipped.
        }
      }
    }
  };
  if (roots.length === 0) return [];
  read(subtreeOf(ws, roots));
  // Up from each connected page to the top.
  for (const root of roots) {
    let cur = out.get(root);
    for (let depth = 0; cur?.parentId && depth < 200; depth++) {
      if (!out.has(cur.parentId)) read([cur.parentId]);
      cur = out.get(cur.parentId);
    }
  }
  for (let step = 0; step < 2; step++) {
    const targets = new Set<string>();
    for (const n of out.values()) for (const p of n.kind === "database" ? (n.db?.properties ?? []) : []) if (p.relation?.dbId) targets.add(p.relation.dbId);
    read(targets);
  }
  return [...out.values()];
}

function findIn(list: RawBlock[], forms: Set<string>, parent: RawBlock | null): Omit<BlockHit, "note"> | null {
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (!b || typeof b !== "object") continue;
    // A suggested block (sg~…) is not the page's yet: the API never finds it.
    if (typeof b.id === "string" && b.id.startsWith("sg~")) continue;
    if (typeof b.id === "string" && forms.has(b.id)) return { block: b, parent, list, index: i };
    if (Array.isArray(b.children) && b.children.length) {
      const hit = findIn(b.children, forms, b);
      if (hit) return hit;
    }
  }
  return null;
}
