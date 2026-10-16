// Server-only: what a push may say about a database's data sources
// (lib/notes/sources.ts). A database can show a data source of another
// database (a linked source, or a view naming one): only someone who may
// read that source can point at it, and a form view (whose public link adds
// rows) only at a source they may edit. Anything else pushed stays as
// stored, or is left out. Data sources' own rows and properties are notes of
// their own and go through the usual access checks.

import { NOTE_ID_RE, type DbView, type Note } from "./types";
import { viewSourceId } from "./sources";

export interface SourcePusher {
  /** May read the note (any level). */
  canRead: (id: string) => boolean;
  /** May edit the note. */
  canEdit: (id: string) => boolean;
  /** The stored parent of a note (null: top level or unknown). */
  parentOf: (id: string) => string | null;
  /** Whether the note is on the server (a source pushed in the same batch, after its database, is not yet). */
  exists: (id: string) => boolean;
}

/** The note with every data source reference this pusher may not make put back as stored (or dropped). */
export function guardSources(stored: Note | null, next: Note, who: SourcePusher): Note {
  if (next.kind !== "database" || !next.db) return next;
  const db = next.db;
  // Its own data sources (database notes under it) are its own business.
  const own = (id: string) => id === next.id || who.parentOf(id) === next.id;
  const before = new Set(stored?.db?.linked ?? []);
  let linked = db.linked;
  // A note not on the server yet has nothing to show; once it arrives, its own access decides.
  const readable = (id: string) => !who.exists(id) || who.canRead(id);
  const editable = (id: string) => !who.exists(id) || who.canEdit(id);
  if (linked?.some((id) => !before.has(id) && !(readable(id) && !own(id)))) {
    linked = linked.filter((id) => before.has(id) || (NOTE_ID_RE.test(id) && readable(id) && !own(id)));
  }
  const was = new Map((stored?.db?.views ?? []).map((v) => [v.id, v]));
  let changed = linked !== db.linked;
  const views = db.views.map((v): DbView => {
    const src = viewSourceId(next.id, v);
    const old = was.get(v.id);
    const oldSrc = old ? viewSourceId(next.id, old) : null;
    // Unchanged (same source, and a form stays a form only on a source it already had).
    if (oldSrc === src && (v.type !== "form" || old?.type === "form")) return v;
    if (src === next.id) return v;
    const ok = v.type === "form" ? editable(src) : readable(src);
    if (ok) return v;
    changed = true;
    const { source: _s, ...rest } = v;
    void _s;
    return oldSrc && oldSrc !== next.id ? { ...rest, source: oldSrc } : rest;
  });
  if (!changed) return next;
  return { ...next, db: { ...db, views, ...(linked?.length ? { linked } : { linked: undefined }) } };
}
