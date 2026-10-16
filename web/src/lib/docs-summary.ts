// Server-only: short lists of a workspace's documents for Home and the
// Design bridge (titles and times only — never document content).

import { AccessResolver } from "./notes/access";
import { displayTitle, iconText, noteSlug } from "./notes/model";
import type { Note } from "./notes/types";
import { sql } from "./store";

export interface DocBrief {
  id: string;
  title: string;
  icon: string;
  kind: Note["kind"];
  updatedAt: number;
  href: string;
}

/** Recently changed pages and databases (not database rows, trash or hidden blocks); with `viewer`, only what they may read. */
export function recentDocs(ws: string, limit = 8, untitled = "Untitled", viewer?: string): DocBrief[] {
  const acc = viewer ? new AccessResolver(ws, viewer) : null;
  const rows = sql("SELECT json FROM notes WHERE ws = ? AND deleted = 0 ORDER BY client_at DESC LIMIT 400").all(ws) as { json: string | null }[];
  const byId = new Map<string, Note>();
  for (const r of rows) {
    try {
      const n = JSON.parse(r.json ?? "null") as Note | null;
      if (n?.id) byId.set(n.id, n);
    } catch {
      // A broken row is skipped.
    }
  }
  // A row's database or a page's ancestors may be older than the 400 most
  // recent notes: they are looked up.
  type Meta = Pick<Note, "kind" | "parentId" | "trashedAt">;
  const older = new Map<string, Meta | null>();
  const metaOf = (id: string): Meta | null => {
    const known = byId.get(id);
    if (known) return known;
    if (!older.has(id)) {
      const r = sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, id) as { json: string | null } | undefined;
      let meta: Meta | null = null;
      try {
        const n = JSON.parse(r?.json ?? "null") as Note | null;
        meta = n ? { kind: n.kind, parentId: n.parentId ?? null, trashedAt: n.trashedAt ?? null } : null;
      } catch {
        meta = null;
      }
      older.set(id, meta);
    }
    return older.get(id) ?? null;
  };
  // Only the root of a trashed subtree carries trashedAt.
  const inTrash = (n: Meta): boolean => {
    let cur: Meta | null = n;
    for (let depth = 0; cur && depth < 100; depth++) {
      if (cur.trashedAt !== null) return true;
      cur = cur.parentId ? metaOf(cur.parentId) : null;
    }
    return false;
  };
  const out: DocBrief[] = [];
  for (const n of byId.values()) {
    if (n.synced || n.template || inTrash(n)) continue;
    // Someone else's Private, a restricted page, a closed teamspace…: not even the title.
    if (acc && acc.level(n.id) === null) continue;
    if (n.parentId && metaOf(n.parentId)?.kind === "database") continue;
    out.push({
      id: n.id,
      title: displayTitle(n, untitled),
      icon: iconText(n.icon),
      kind: n.kind,
      updatedAt: n.updatedAt,
      href: `/docs?ws=${encodeURIComponent(ws)}#${noteSlug(n)}`,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export function docCount(ws: string): number {
  const r = sql("SELECT COUNT(*) AS n FROM notes WHERE ws = ? AND deleted = 0").get(ws) as { n: number };
  return Number(r.n);
}
