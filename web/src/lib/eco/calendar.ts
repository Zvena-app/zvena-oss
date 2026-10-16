// The ecosystem's side of Calendar. Server-only.
//
// Events are objects of the ecosystem like pages and issues (event:<id>):
//   - cards: what a person sees of an event, by the rule of its calendar
//     (lib/calendar/access.ts) — nothing for someone who cannot open it;
//   - search: the title and a short plain text in eco_search (rows above
//     EVENT_ROWID_BASE), each hit checked per person;
//   - links: zvena addresses and @mentions in the description, the pages
//     attached to it and its guests who are members (setDerived, as Design's
//     comments are indexed);
//   - "Turn into issue": the event quoted, inert, in a new issue, and a
//     "converted" link both ways.

import { canSeeEvent, CalAccess, calRow, eventRef, type CalRow } from "../calendar/access";
import { calDb, EVENT_ROWID_BASE } from "../calendar/db";
import { prefsOf } from "../calendar/calendars";
import { attendeesOf, eventRow, parseJson, type EvRow } from "../calendar/events";
import { intlOf } from "@/i18n/locales";
import { trackEvent } from "../decide/flows";
import { ctxFor, type Ctx } from "../projects/core";
import { createIssue } from "../projects/issues";
import { plainText } from "../projects/markdown";
import { sql } from "../store";
import { EcoError, teamFor, visibleProjectId, type Actor } from "./actions";
import { cardsFor, type Viewer } from "./cards";
import { refsInMarkdown } from "./extract";
import { origins, resolveTargets, systemCtx } from "./indexer";
import { addLink, setDerived, type DerivedVia } from "./links";
import { refHref } from "./refs";
import { ecoDb } from "./schema";
import { ecoText } from "./strings";
import type { Card } from "./types";

const keyOf = (id: string) => `event:${id}`;

/** Search row and links of one event, as it is now (a gone or deleted event leaves neither). */
export function indexEvent(ws: string, id: string, by: string | null = null): void {
  ecoDb();
  calDb();
  const r = eventRow(id);
  if (!r) return;
  const rowid = EVENT_ROWID_BASE + Number(r.seq);
  sql("DELETE FROM eco_search WHERE rowid = ?").run(rowid);
  // Overrides of one occurrence are found through their series.
  if (r.deleted_at || r.parent_id || r.ws_id !== ws) {
    setDerived(ws, keyOf(id), "", [], by);
    return;
  }
  const body = [plainText(r.description, 2000), r.location].filter(Boolean).join(" · ");
  sql("INSERT INTO eco_search (rowid, ws, title, body) VALUES (?, ?, ?, ?)").run(rowid, ws, r.title, body);
  const targets: { dst: string; via: DerivedVia }[] = resolveTargets(ws, refsInMarkdown(r.description, origins()), systemCtx(ws));
  for (const n of parseJson<string[]>(r.docs, [])) targets.push({ dst: `note:${n}`, via: "link" });
  for (const a of attendeesOf(r.id)) if (a.user_id) targets.push({ dst: `user:${a.user_id}`, via: "relation" });
  setDerived(ws, keyOf(id), "", targets, by);
}

function whenText(r: EvRow, locale: string, tz: string): string {
  try {
    if (r.all_day === 1) {
      const [y, m, d] = r.start_day.split("-").map(Number);
      return new Intl.DateTimeFormat(intlOf(locale), { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
    }
    return new Intl.DateTimeFormat(intlOf(locale), { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(r.start_at));
  } catch {
    return r.start_day;
  }
}

/** Cards of events, only those the viewer may open. */
export function eventCards(v: Viewer, ids: string[]): Map<string, Card> {
  const out = new Map<string, Card>();
  if (!ids.length) return out;
  calDb();
  const acc = new CalAccess(v.userId, v.wsId);
  if (!acc.member) return out;
  const tz = prefsOf(v.userId).tz;
  for (const id of ids.slice(0, 200)) {
    const r = eventRow(id);
    if (!r || !canSeeEvent(acc, r)) continue;
    const cal = calRow(r.cal_id);
    out.set(keyOf(id), {
      key: keyOf(id),
      kind: "event",
      title: r.title || ecoText(v.locale, "untitled"),
      url: refHref({ kind: "event", id }, v.wsId),
      color: r.color ?? cal?.color ?? undefined,
      sub: `${whenText(r, v.locale, tz)}${r.rrule ? " ↻" : ""}`,
      updatedAt: r.updated_at,
    });
  }
  return out;
}

const LIMIT = 8;
const ftsPhrase = (q: string) => `"${q.replace(/"/g, '""')}"`;
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Events matching `q` that the viewer may open, best first, with a few words around the match. */
export function eventHits(v: Viewer, q: string): { key: string; snippet?: string }[] {
  ecoDb();
  calDb();
  const acc = new CalAccess(v.userId, v.wsId);
  if (!acc.member) return [];
  // Only calendars the person reads, or events they are a guest of — in the query, before any limit.
  const readable = (sql("SELECT * FROM cal_calendars WHERE ws_id = ? AND deleted_at IS NULL").all(v.wsId) as unknown as CalRow[]).filter((c) => acc.canRead(c)).map((c) => c.id);
  const mine = `(e.cal_id IN (SELECT value FROM json_each(?)) OR EXISTS (SELECT 1 FROM cal_attendees a WHERE a.event_id = e.id AND a.user_id = ?))`;
  const scope = [JSON.stringify(readable), v.userId];
  let rows: { id: string; snip?: string | null }[] = [];
  if ([...q].length >= 3) {
    try {
      rows = sql(
        `SELECT e.id AS id, snippet(eco_search, 2, '', '', '…', 32) AS snip
         FROM eco_search JOIN cal_events e ON e.seq = eco_search.rowid - ${EVENT_ROWID_BASE}
         WHERE eco_search MATCH ? AND eco_search.rowid >= ${EVENT_ROWID_BASE} AND e.ws_id = ? AND e.deleted_at IS NULL AND ${mine}
         ORDER BY bm25(eco_search, 0.0, 10.0, 1.0) LIMIT ?`
      ).all(`ws : ${ftsPhrase(v.wsId)} AND {title body} : ${ftsPhrase(q)}`, v.wsId, ...scope, LIMIT * 5) as { id: string; snip: string | null }[];
    } catch {
      rows = [];
    }
  }
  const out: { key: string; snippet?: string }[] = [];
  const take = (list: { id: string; snip?: string | null }[]) => {
    for (const r of list) {
      if (out.length >= LIMIT) break;
      if (out.some((o) => o.key === keyOf(r.id)) || !canSeeEvent(acc, eventRef(r.id))) continue;
      out.push({ key: keyOf(r.id), ...(r.snip?.trim() ? { snippet: r.snip.trim() } : {}) });
    }
  };
  take(rows);
  // Short words (the index needs three letters), or nothing visible matched: titles, the same scope.
  if (!out.length)
    take(sql(`SELECT e.id AS id FROM cal_events e WHERE e.ws_id = ? AND e.deleted_at IS NULL AND e.parent_id IS NULL AND e.title LIKE ? ESCAPE '\\' AND ${mine} ORDER BY e.start_at DESC LIMIT ?`).all(v.wsId, likePattern(q), ...scope, LIMIT * 5) as { id: string }[]);
  return out;
}

/** Markdown-inert text: what an event says can never become a link (bare URLs included), an image or a mention. */
const inert = (s: string) => s.replace(/[\\`*_{}[\]()#+\-.!|<>~@&:/?=%]/g, (c) => `\\${c}`);
const mdText = (s: string) => s.replace(/[[\]\\]/g, (c) => `\\${c}`).replace(/\s+/g, " ").trim();

function editCtx(a: Actor): Ctx {
  try {
    return ctxFor(a.userId, a.wsId, "edit");
  } catch {
    throw new EcoError(403, "forbidden");
  }
}

/**
 * An event becomes an issue: due on the event's day, its description quoted
 * (inert) with a link back, and a "converted" link so either side finds the
 * other even after the text changes.
 */
export async function issueFromEvent(a: Actor, input: { event?: unknown; occ?: unknown; title?: unknown; teamId?: unknown; projectId?: unknown }): Promise<Card> {
  const ctx = editCtx(a);
  const id = typeof input.event === "string" ? input.event : "";
  const r = id ? eventRow(id) : null;
  if (!r || !canSeeEvent(new CalAccess(a.userId, a.wsId), r)) throw new EcoError(404, "event not found");
  const title = (typeof input.title === "string" && input.title.trim() ? input.title : r.title || ecoText(a.locale, "untitled")).replace(/\s+/g, " ").trim().slice(0, 300);
  const occ = typeof input.occ === "string" && /^\d{8}(T\d{6}Z)?$/.test(input.occ) ? input.occ : null;
  const due = occ ? `${occ.slice(0, 4)}-${occ.slice(4, 6)}-${occ.slice(6, 8)}` : r.start_day;
  const url = `${refHref({ kind: "event", id: r.id }, a.wsId)}${occ ? `&occ=${occ}` : ""}`;
  const said = plainText(r.description, 4000);
  const issue = createIssue(ctx, {
    teamId: typeof input.teamId === "string" && input.teamId ? input.teamId : teamFor(ctx, a.locale),
    title,
    description: `${ecoText(a.locale, "fromEvent")} [${mdText(r.title) || ecoText(a.locale, "untitled")}](${url})${said ? `\n\n> ${inert(said)}` : ""}`,
    projectId: visibleProjectId(ctx, input.projectId),
    dueDate: due,
  });
  addLink(a.wsId, keyOf(r.id), `issue:${issue.id}`, "converted", a.userId, a.origin);
  // A one-off meeting: the issue's due date follows it when it moves (lib/decide/flows.ts).
  if (!r.rrule && !r.parent_id) trackEvent(a.wsId, r.id, issue.id, due, a.userId);
  const [card] = await cardsFor(a, [`issue:${issue.id}`]);
  if (!card) throw new EcoError(500, "not created");
  return card;
}
