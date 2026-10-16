// Server-only: our notes, people and integrations as Notion API objects
// (page, database, user), and the lookup contexts the mappers need.

import { config } from "../../config";
import { sql } from "../../store";
import { membersOf } from "../../workspaces";
import { computeRows } from "../compute";
import { isSourceNote, noteSlug } from "../model";
import { sourceName } from "../sources";
import type { Note } from "../types";
import type { BlockContext } from "./blocks";
import type { Integration } from "./integrations";
import { integrationNames } from "./integrations";
import { propertyKeys, propertyValues, schemaProperty, type ValueContext } from "./properties";
import { toRichText } from "./richtext";
import { toUuid, usesDataSources, type Space } from "./space";

export interface Person {
  id: string;
  name: string;
  avatar: string | null;
  email: string | null;
}

/** The people an integration may name: members of its workspace (and its fellow integrations as bots). */
export class Directory {
  readonly people = new Map<string, Person>();
  readonly bots = new Map<string, { name: string; icon: string }>();

  constructor(readonly integration: Integration) {
    for (const m of membersOf(integration.ws)) this.people.set(m.userId, { id: m.userId, name: m.name, avatar: m.avatar ?? null, email: null });
    if (integration.caps.users === "emails" && this.people.size) {
      const rows = sql(`SELECT id, email FROM users WHERE id IN (${[...this.people.keys()].map(() => "?").join(",")})`).all(...this.people.keys()) as { id: string; email: string | null }[];
      for (const r of rows) {
        const p = this.people.get(r.id);
        if (p) p.email = r.email;
      }
    }
    for (const b of integrationNames(integration.ws)) this.bots.set(b.id, { name: b.name, icon: b.icon });
  }

  name(id: string | undefined): string | null {
    if (!id) return null;
    if (id.startsWith("integration:")) return this.bots.get(id)?.name ?? null;
    return this.people.get(id)?.name ?? null;
  }

  /** A user object: partial ({ object, id }) unless the integration may read user information. */
  user(id: string | undefined): Record<string, unknown> {
    if (!id) return { object: "user", id: null };
    if (id.startsWith("integration:")) {
      const raw = id.slice("integration:".length);
      const bot = this.bots.get(id);
      return this.integration.caps.users === "none" || !bot ? { object: "user", id: toUuid(raw) } : { object: "user", id: toUuid(raw), type: "bot", name: bot.name, avatar_url: null, bot: {} };
    }
    const p = this.people.get(id);
    if (!p || this.integration.caps.users === "none") return { object: "user", id };
    return personObject(p, this.integration.caps.users === "emails");
  }
}

export function personObject(p: Person, withEmail: boolean): Record<string, unknown> {
  return { object: "user", id: p.id, type: "person", name: p.name, avatar_url: p.avatar, person: withEmail && p.email ? { email: p.email } : {} };
}

/** The integration itself as a bot user (GET /users/me). */
export function botObject(i: Integration): Record<string, unknown> {
  const ws = sql("SELECT name FROM workspaces WHERE id = ?").get(i.ws) as { name: string } | undefined;
  return {
    object: "user",
    id: toUuid(i.id),
    type: "bot",
    name: i.name,
    avatar_url: null,
    bot: { owner: { type: "workspace", workspace: true }, workspace_name: ws?.name ?? null },
  };
}

export function pageUrl(ws: string, n: Pick<Note, "id" | "title">): string {
  return `${config.appUrl}/docs?ws=${encodeURIComponent(ws)}#${noteSlug(n)}`;
}

const absolute = (url: string) => (url.startsWith("/") ? `${config.appUrl}${url}` : url);

/** Everything the mappers ask about while one request runs. */
export function contexts(space: Space, dir: Directory, pageId = ""): BlockContext & ValueContext {
  return {
    pageId,
    title: (id) => space.note(id)?.title ?? null,
    isDatabase: (id) => space.note(id)?.kind === "database",
    personName: (id) => dir.name(id),
    pageUrl: (id) => {
      const n = space.note(id);
      return n ? pageUrl(space.integration.ws, n) : "";
    },
    absolute,
    note: (id) => space.note(id),
    user: (id) => dir.user(id) as { object: "user"; id: string },
    visible: (id) => space.note(id) !== null,
  };
}

function iconObject(icon: string): Record<string, unknown> | null {
  if (!icon) return null;
  if (icon.startsWith("/")) return { type: "file", file: { url: absolute(icon), expiry_time: null } };
  if (icon.startsWith("icon:")) return null;
  return { type: "emoji", emoji: icon };
}

function coverObject(n: Note): Record<string, unknown> | null {
  if (!n.cover || n.cover.kind !== "image") return null;
  const url = n.cover.value;
  return url.startsWith("/") ? { type: "file", file: { url: absolute(url), expiry_time: null } } : { type: "external", external: { url } };
}

function parentObject(n: Note, space: Space): Record<string, unknown> {
  const parent = n.parentId ? space.notes.get(n.parentId) : undefined;
  if (!parent) return { type: "workspace", workspace: true };
  if (parent.kind === "database") {
    // 2025-09-03: a row's parent is its data source (with the database it is in); a data source's, its database.
    if (usesDataSources(space.version) && n.kind === "page") return { type: "data_source_id", data_source_id: toUuid(parent.id), database_id: toUuid(space.hostOf(parent).id) };
    return { type: "database_id", database_id: toUuid(parent.id) };
  }
  return { type: "page_id", page_id: toUuid(parent.id) };
}

function common(n: Note, space: Space, dir: Directory): Record<string, unknown> {
  const trashed = space.inTrash(n);
  return {
    id: toUuid(n.id),
    created_time: new Date(n.createdAt).toISOString(),
    last_edited_time: new Date(n.updatedAt).toISOString(),
    created_by: dir.user(n.createdBy),
    last_edited_by: dir.user(n.editedBy ?? n.createdBy),
    cover: coverObject(n),
    icon: iconObject(n.icon),
    parent: parentObject(n, space),
    archived: trashed,
    in_trash: trashed,
    url: pageUrl(space.integration.ws, n),
    public_url: n.share?.id ? `${config.appUrl}/n/${n.share.id}` : null,
  };
}

/** A row with its formulas and rollups computed (as the app shows them). */
export function computed(n: Note, space: Space): Note {
  const db = n.parentId ? space.notes.get(n.parentId) : undefined;
  if (db?.kind !== "database" || !db.db) return n;
  return computeRows([n], db.db, space.notes, "en")[0] ?? n;
}

export function pageObject(n: Note, space: Space, dir: Directory): Record<string, unknown> {
  const ctx = contexts(space, dir, n.id);
  const db = n.parentId ? space.notes.get(n.parentId) : undefined;
  const properties =
    db?.kind === "database" && db.db
      ? propertyValues(computed(n, space), db.db, ctx)
      : { title: { id: "title", type: "title", title: toRichText(n.title ? [{ type: "text", text: n.title, styles: {} }] : [], ctx) } };
  return { object: "page", ...common(n, space, dir), properties };
}

function schemaOut(n: Note, space: Space): Record<string, unknown> {
  const schema = n.db ?? { properties: [], views: [] };
  const properties: Record<string, unknown> = {};
  for (const [key, p] of propertyKeys(schema)) properties[key] = schemaProperty(p, schema, (id) => space.note(id));
  return properties;
}

/**
 * A database. Before 2025-09-03: with its property schema (each data source
 * reads as a database of its own). From 2025-09-03: with the list of its
 * data sources instead (their schemas are on GET /v1/data_sources/{id}).
 */
export function databaseObject(n: Note, space: Space, dir: Directory): Record<string, unknown> {
  const ctx = contexts(space, dir, n.id);
  const title = toRichText(n.title ? [{ type: "text", text: n.title, styles: {} }] : [], ctx);
  if (usesDataSources(space.version)) {
    return {
      object: "database",
      ...common(n, space, dir),
      title,
      description: [],
      is_inline: n.inline === true,
      is_locked: n.style?.locked === true,
      data_sources: space.sourcesOf(n).map((s) => ({ id: toUuid(s.id), name: sourceName(n, s, "") })),
    };
  }
  return {
    object: "database",
    ...common(n, space, dir),
    title,
    description: [],
    is_inline: n.inline === true,
    properties: schemaOut(n, space),
  };
}

/** A data source (2025-09-03): a database's first one (the database note itself) or a further one (a database note in it). */
export function dataSourceObject(n: Note, space: Space, dir: Directory): Record<string, unknown> {
  const host = space.hostOf(n);
  const ctx = contexts(space, dir, n.id);
  const name = sourceName(host, n, "");
  const base = common(n, space, dir);
  return {
    object: "data_source",
    ...base,
    // Its database, and where that database is (Notion's database_parent).
    parent: { type: "database_id", database_id: toUuid(host.id) },
    database_parent: host === n ? base.parent : parentObject(host, space),
    url: pageUrl(space.integration.ws, host),
    title: toRichText(name ? [{ type: "text", text: name, styles: {} }] : [], ctx),
    description: [],
    is_inline: host.inline === true,
    properties: schemaOut(n, space),
  };
}

/** A search hit or a "page or database" result, in the request's version. */
export function noteObject(n: Note, space: Space, dir: Directory): Record<string, unknown> {
  if (n.kind !== "database") return pageObject(n, space, dir);
  return usesDataSources(space.version) ? dataSourceObject(n, space, dir) : databaseObject(n, space, dir);
}

/** Whether the note is a further data source in a database (not a database of its own). */
export const isFurtherSource = (n: Note, space: Space): boolean => isSourceNote(n) && space.hostOf(n) !== n;
