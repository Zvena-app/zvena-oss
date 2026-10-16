// One search box for the whole workspace: documents, issues, projects,
// designs and calendar events together, and the searcher's own mail.
// Server-only. Each product is searched the way it searches itself (Projects'
// own full-text index, Design's file list, Mail's per-person index) and the
// Documents catalog has its own index; every hit is a card the person may see.

import { listProjects } from "../projects/planning";
import { ecoText } from "./strings";
import { search as searchProjects } from "../projects/workspace";
import { ctxFor, type Ctx } from "../projects/core";
import { queryIssues } from "../projects/issues";
import { designConfigured, teamFiles, type DesignFile } from "../penpot";
import { AccessResolver } from "../notes/access";
import { sql } from "../store";
import { eventHits } from "./calendar";
import { searchMailThreads } from "../mail-client/search";
import { cardsFor, type Viewer } from "./cards";
import { refHref } from "./refs";
import { ecoDb } from "./schema";
import type { Card, SearchHit, SearchResults } from "./types";

const LIMIT = 8;

function ftsPhrase(q: string): string {
  return `"${q.replace(/"/g, '""')}"`;
}

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Pages of the catalog read until `want` of them are the person's to open (others' private pages never crowd theirs out). */
function readable<T extends { id: string }>(v: Viewer, page: (offset: number, n: number) => T[], want: number): T[] {
  const acc = new AccessResolver(v.wsId, v.userId);
  const out: T[] = [];
  const n = want * 3;
  for (let offset = 0; out.length < want && offset < n * 10; offset += n) {
    const rows = page(offset, n);
    for (const r of rows) if (acc.level(r.id) !== null) out.push(r);
    if (rows.length < n) break;
  }
  return out.slice(0, want);
}

function docHits(v: Viewer, q: string): { id: string; snippet?: string }[] {
  // Trigram search needs three characters; shorter queries match titles.
  if ([...q].length >= 3) {
    try {
      // The workspace is a column of the index: a phrase match on it narrows the search inside the
      // index; the exact ws_id filter stays (trigrams ignore case).
      return readable(
        v,
        (offset, n) =>
          (
            sql(
              `SELECT d.note_id AS id, snippet(eco_search, 2, '', '', '…', 48) AS snip
               FROM eco_search JOIN eco_docs d ON d.fts_id = eco_search.rowid
               WHERE eco_search MATCH ? AND d.ws_id = ? AND d.flags & 2 = 0
               ORDER BY bm25(eco_search, 0.0, 10.0, 1.0) LIMIT ? OFFSET ?`
            ).all(`ws : ${ftsPhrase(v.wsId)} AND {title body} : ${ftsPhrase(q)}`, v.wsId, n, offset) as { id: string; snip: string | null }[]
          ).map((r) => ({ id: r.id, snippet: r.snip?.trim() || undefined })),
        LIMIT * 3
      );
    } catch {
      // A query FTS cannot parse falls back to titles.
    }
  }
  return readable(
    v,
    (offset, n) => sql("SELECT note_id AS id FROM eco_docs WHERE ws_id = ? AND flags & 2 = 0 AND title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ? OFFSET ?").all(v.wsId, likePattern(q), n, offset) as { id: string }[],
    LIMIT * 3
  );
}

const designFiles = new Map<string, { at: number; files: DesignFile[] }>();

async function filesOf(v: Viewer): Promise<DesignFile[]> {
  if (!designConfigured()) return [];
  const team = (sql("SELECT penpot_team_id FROM workspaces WHERE id = ?").get(v.wsId) as { penpot_team_id: string | null } | undefined)?.penpot_team_id;
  if (!team) return [];
  const k = `${v.userId}|${team}`;
  const hit = designFiles.get(k);
  if (hit && Date.now() - hit.at < 30_000) return hit.files;
  let files: DesignFile[] = [];
  try {
    files = (await teamFiles(v.userId, team)).files;
  } catch {
    files = hit?.files ?? [];
  }
  designFiles.set(k, { at: Date.now(), files });
  if (designFiles.size > 1000) designFiles.clear();
  return files;
}

function designCard(v: Viewer, f: DesignFile): Card {
  return { key: `design:${f.id}`, kind: "design", title: f.name, url: refHref({ kind: "design", file: f.id }, v.wsId), sub: f.project || ecoText(v.locale, "design"), updatedAt: Date.parse(f.modifiedAt) || undefined };
}

function projectsCtx(v: Viewer): Ctx | null {
  try {
    return ctxFor(v.userId, v.wsId, "read");
  } catch {
    return null;
  }
}

/** Markdown left in a cut-out piece of text: "[Plan](/docs#…)" reads "Plan". */
function plain(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)?/g, "$1")
    .replace(/\[@[^\]]*label="([^"]*)"[^\]]*\]/g, "@$1")
    .replace(/[[\]*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A few words around the match, only when the title does not already show it. */
function snippetFor(raw: string | undefined, title: string, lower: string): string | undefined {
  if (!raw || title.toLocaleLowerCase().includes(lower)) return undefined;
  const text = plain(raw);
  return text.toLocaleLowerCase().includes(lower) ? text : undefined;
}

/** Everything in the workspace that matches `q`, best first within each kind. */
export async function searchAll(v: Viewer, raw: string): Promise<SearchResults> {
  ecoDb();
  const q = raw.trim().slice(0, 200);
  if (!q) return { q, hits: await recent(v) };
  const ctx = projectsCtx(v);
  const pj = ctx ? searchProjects(ctx, q, LIMIT) : { issues: [], projects: [], teams: [], labels: [] };
  const docs = docHits(v, q);
  const lower = q.toLocaleLowerCase();
  const files = (await filesOf(v)).filter((f) => f.name.toLocaleLowerCase().includes(lower)).slice(0, LIMIT);
  const events = eventHits(v, q);
  // The searcher's own mail, from Mail's own index (mail is never in the shared eco_search).
  const mail = searchMailThreads(v.userId, q, 5);
  const snippets = new Map<string, string | undefined>([...pj.issues.map((i) => [`issue:${i.id}`, i.snippet || undefined] as const), ...docs.map((d) => [`note:${d.id}`, d.snippet] as const), ...events.map((e) => [e.key, e.snippet] as const), ...mail.map((m) => [`mail:${m.id}`, m.snippet] as const)]);
  const cards = await cardsFor(v, [...pj.issues.map((i) => `issue:${i.id}`), ...pj.projects.map((p) => `project:${p.id}`), ...docs.map((d) => `note:${d.id}`), ...events.map((e) => e.key), ...mail.map((m) => `mail:${m.id}`)]);
  const byKind = (k: Card["kind"]) => cards.filter((c) => c.kind === k).slice(0, LIMIT);
  const hits: SearchHit[] = [...byKind("issue"), ...byKind("note"), ...byKind("project"), ...byKind("event"), ...byKind("mail")].map((c) => ({ ...c, snippet: snippetFor(snippets.get(c.key), c.title, lower) }));
  hits.push(...files.map((f) => designCard(v, f)));
  return { q, hits };
}

/** With nothing typed: my open issues, the latest documents, active projects and designs. */
export async function recent(v: Viewer): Promise<SearchHit[]> {
  ecoDb();
  const ctx = projectsCtx(v);
  const keys: string[] = [];
  if (ctx) {
    try {
      const page = queryIssues(ctx, { filter: { assignee: ["me"], category: ["started", "unstarted"] }, display: { group: "none", order: "updated", subIssues: true }, limit: 5 });
      for (const g of page.groups) for (const i of g.items) keys.push(`issue:${i.id}`);
    } catch {
      // Projects not set up for this person yet.
    }
  }
  const docs = readable(v, (offset, n) => sql("SELECT note_id AS id FROM eco_docs WHERE ws_id = ? AND flags = 0 AND trashed_at IS NULL ORDER BY updated_at DESC LIMIT ? OFFSET ?").all(v.wsId, n, offset) as { id: string }[], 6);
  keys.push(...docs.map((d) => `note:${d.id}`));
  if (ctx) {
    for (const p of listProjects(ctx)
      .filter((p) => p.state === "started" || p.state === "planned")
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 3))
      keys.push(`project:${p.id}`);
  }
  const hits: SearchHit[] = await cardsFor(v, keys);
  hits.push(...(await filesOf(v)).slice(0, 3).map((f) => designCard(v, f)));
  return hits;
}
