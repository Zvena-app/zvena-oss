// Server-only: workspace analytics (Notion's Settings → Analytics), for the
// workspace's owners. From what Documents already keep: page views
// (note_views: one per person and page per 30 minutes; never for someone who
// turned their page view history off), edit sessions (note_versions) and
// created pages (note_events). Pages are listed by title only when the asker
// may open them — a member's Private page counts, but stays "a page".

import { sql } from "../store";
import { membersOf } from "../workspaces";
import { pageLevel } from "./access";
import { hiddenViewers } from "./follows";

const DAY = 86_400_000;
export const ANALYTICS_SPANS = [7, 28, 90] as const;
const TOP = 20;

export interface WorkspaceAnalytics {
  span: number;
  members: number;
  /** Members who opened or edited a page in the period. */
  active: number;
  views: number;
  edits: number;
  created: number;
  /** Per day, oldest first, the last entry being today (in the asker's time zone). */
  days: { views: number[]; edits: number[]; active: number[] };
  /** The most viewed and most edited pages; `title` null when the asker may not open the page. */
  pages: { id: string; title: string | null; views: number; viewers: number; edits: number; editedAt: number | null }[];
  people: { id: string; name: string; role: string; activeAt: number | null; views: number | null; edits: number; created: number }[];
}

export function workspaceAnalytics(ws: string, viewer: string, span: number, now = Date.now(), tz = 0): WorkspaceAnalytics {
  const offset = Math.max(-840, Math.min(840, Math.round(tz))) * 60_000;
  const today = Math.floor((now + offset) / DAY);
  const first = today - span + 1;
  const since = first * DAY - offset;
  const dayOf = (at: number) => Math.floor((at + offset) / DAY) - first;
  const members = membersOf(ws);
  const memberIds = new Set(members.map((m) => m.userId));
  const hidden = hiddenViewers(members.map((m) => m.userId));

  const views = new Array<number>(span).fill(0);
  const edits = new Array<number>(span).fill(0);
  const activeDays = Array.from({ length: span }, () => new Set<string>());
  const person = new Map<string, { views: number; edits: number; created: number; at: number }>();
  const touch = (id: string, at: number) => {
    const p = person.get(id) ?? { views: 0, edits: 0, created: 0, at: 0 };
    p.at = Math.max(p.at, at);
    person.set(id, p);
    return p;
  };
  const page = new Map<string, { views: number; viewers: Set<string>; edits: number; at: number }>();
  const pageOf = (id: string) => {
    const p = page.get(id) ?? { views: 0, viewers: new Set<string>(), edits: 0, at: 0 };
    page.set(id, p);
    return p;
  };

  for (const r of sql("SELECT note_id, user_id, at FROM note_views WHERE ws = ? AND at >= ?").iterate(ws, since) as Iterable<{ note_id: string; user_id: string; at: number }>) {
    const i = dayOf(Number(r.at));
    if (i < 0 || i >= span) continue;
    views[i] += 1;
    const pg = pageOf(r.note_id);
    pg.views += 1;
    pg.viewers.add(r.user_id);
    if (!memberIds.has(r.user_id) || hidden.has(r.user_id)) continue;
    activeDays[i].add(r.user_id);
    touch(r.user_id, Number(r.at)).views += 1;
  }
  let editsTotal = 0;
  for (const r of sql("SELECT note_id, by, at FROM note_versions WHERE ws = ? AND at >= ? AND by IS NOT NULL").iterate(ws, since) as Iterable<{ note_id: string; by: string; at: number }>) {
    const i = dayOf(Number(r.at));
    if (i < 0 || i >= span) continue;
    edits[i] += 1;
    editsTotal += 1;
    const pg = pageOf(r.note_id);
    pg.edits += 1;
    pg.at = Math.max(pg.at, Number(r.at));
    if (!memberIds.has(r.by)) continue;
    activeDays[i].add(r.by);
    touch(r.by, Number(r.at)).edits += 1;
  }
  let created = 0;
  for (const r of sql("SELECT by, at FROM note_events WHERE ws = ? AND kind = 'create' AND at >= ?").iterate(ws, since) as Iterable<{ by: string | null; at: number }>) {
    if (dayOf(Number(r.at)) < 0) continue;
    created += 1;
    if (r.by && memberIds.has(r.by)) touch(r.by, Number(r.at)).created += 1;
  }

  // The top pages, by views then edits (pages deleted since are left out).
  const ranked = [...page.entries()].sort((a, b) => b[1].views - a[1].views || b[1].edits - a[1].edits).slice(0, TOP * 2);
  const pages: WorkspaceAnalytics["pages"] = [];
  for (const [id, p] of ranked) {
    if (pages.length >= TOP) break;
    const row = sql("SELECT json_extract(json, '$.title') AS title FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, id) as { title: string | null } | undefined;
    if (!row) continue;
    pages.push({ id, title: pageLevel(viewer, ws, id) ? (row.title ?? "") : null, views: p.views, viewers: p.viewers.size, edits: p.edits, editedAt: p.at || null });
  }

  const people = members
    .map((m) => {
      const p = person.get(m.userId);
      // Someone whose page view history is off shows no views (and no time from them).
      return { id: m.userId, name: m.name, role: m.role, activeAt: p?.at || null, views: hidden.has(m.userId) ? null : (p?.views ?? 0), edits: p?.edits ?? 0, created: p?.created ?? 0 };
    })
    .sort((a, b) => (b.activeAt ?? 0) - (a.activeAt ?? 0) || a.name.localeCompare(b.name));

  return {
    span,
    members: members.length,
    active: people.filter((p) => p.activeAt).length,
    views: views.reduce((a, b) => a + b, 0),
    edits: editsTotal,
    created,
    days: { views, edits, active: activeDays.map((s) => s.size) },
    pages,
    people,
  };
}
