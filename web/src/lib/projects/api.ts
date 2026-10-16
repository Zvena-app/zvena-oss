// HTTP layer of Zvena Projects: one router behind /api/projects/*.
//
// Every request goes through the same gate: a per-IP rate limit, the CSRF
// origin check for writes, the session, and the workspace named by ?ws=
// (membership and role are checked by ctxFor, then by each operation).
// Domain errors (PjError) become JSON errors with their status; anything else
// is a 500 that logs its kind only (never request data).

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { crossSite, currentUser, fail, json } from "../http";
import { enRu } from "@/i18n/locales";
import { isLocale, parseAcceptLanguage, resolveLocale, translate } from "../i18n";
// Every language's strings in this bundle too (the personal workspace's name).
import "../../i18n/server-catalogs";
import { compressImage } from "../images";
import { removeNoteFiles, saveNoteFile, uploadExt, notesFilesDir } from "../notes/files";
import { NOTE_LIMITS } from "../notes/types";
import { rateLimited } from "../rate-limit";
import { readJsonCapped } from "../safe-json";
import { payerOf, quotaLeft } from "../storage";
import { sql } from "../store";
import { LimitError } from "../workspaces";
import * as assist from "./assist";
import { jevState, triageSmart } from "./assist-jev";
import { resolveSuggestion, similarIssues, startAutopilot, suggestionsOf } from "./autopilot";
import { claimConversions, createFromDoc, pendingConversions, planFromDoc } from "./from-doc";
import { goalCountFor, type GoalEvent } from "./goals";
import { triageIssue } from "./triage";
import { insights } from "./insights";
import { bad, changeSeq, ctxFor, needs, PjError, visibleProject, type Ctx } from "./core";
import { cleanDisplay, cleanFilter, displayFromParams, filterFromParams } from "./filter";
import { createIssue, deleteIssues, getIssueBrief, issueState, queryIssues, resolveIssueId, updateIssue, updateIssues } from "./issues";
import {
  addProjectUpdate,
  completeCycle,
  createCycle,
  createProject,
  deleteCycle,
  deleteMilestone,
  deleteProject,
  deleteProjectUpdate,
  getCycle,
  getProject,
  listProjects,
  saveMilestone,
  updateCycle,
  updateProject,
} from "./planning";
import {
  addAttachment,
  addComment,
  addRelation,
  attachmentById,
  attachmentFor,
  attachmentType,
  checkSignedLink,
  deleteAttachment,
  deleteComment,
  editComment,
  issueDetail,
  removeRelation,
  setSubscribed,
  signedLink,
  toggleReaction,
} from "./social";
import {
  createField,
  createLabel,
  createStatus,
  createTeam,
  deleteField,
  deleteLabel,
  deleteStatus,
  deleteTeam,
  setTeamMember,
  updateField,
  updateLabel,
  updateStatus,
  updateTeam,
} from "./teams";
import { bootstrap, deleteView, inbox, markNotifications, readIssueNotifications, saveView, search, setFavorite, unreadCount, listViews } from "./workspace";
import { DEFAULT_DISPLAY, isDate } from "./types";
import { startProjects } from "./start";

type Body = Record<string, unknown>;
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

interface Call {
  req: Request;
  url: URL;
  ctx: Ctx;
  p: Record<string, string>;
  body: Body;
  lang: "ru" | "en";
  /** The interface language (all of zvena's languages): seed data is written in it. */
  locale: string;
}

type Handler = (c: Call) => unknown | Promise<unknown>;

interface Route {
  method: Method;
  path: string[];
  run: Handler;
  /** Raw body (uploads): the JSON body is not read. */
  raw?: boolean;
  scope?: string;
}

const routes: Route[] = [];
function on(method: Method, path: string, run: Handler, opts: { raw?: boolean; scope?: string } = {}): void {
  routes.push({ method, path: path.split("/").filter(Boolean), run, ...opts });
}

const q = (c: Call, k: string) => c.url.searchParams.get(k);
/** Goals this change met (the person who closed the last issue sees it at once): only when there are some. */
const reached = (ctx: Ctx, goals: GoalEvent[]) => {
  const met = goals
    .filter((g) => (g.kind === "met" || g.kind === "milestone") && visibleProject(ctx, g.projectId))
    .map((g) => ({ kind: g.kind, projectId: g.projectId, name: g.name, total: goalCountFor(ctx, g).total }));
  return met.length ? { goals: met } : {};
};
const issueRef = (c: Call) => resolveIssueId(c.ctx, c.p.ref);

// --- Bootstrap and change feed -------------------------------------------------

const bootOf = (ctx: Ctx, locale: string, today?: string) => ({ ...bootstrap(ctx, { personalName: translate(isLocale(locale) ? locale : "en", "ws.personal"), today }), jev: jevState(ctx.wsId) });
on("GET", "bootstrap", (c) => bootOf(c.ctx, c.locale, q(c, "today") ?? undefined));

/**
 * The bootstrap the page sends along with Projects (the same as GET bootstrap
 * with the server's day), so the app starts without waiting for it; null when
 * the person can't read the workspace (the app's own fetch says why).
 */
export function initialBootstrap(userId: string, wsId: string, locale: string): ReturnType<typeof bootOf> | null {
  try {
    return bootOf(ctxFor(userId, wsId, "read"), locale);
  } catch {
    return null;
  }
}
on("GET", "changes", (c) => ({ seq: changeSeq(c.ctx.wsId), unread: unreadCount(c.ctx) }), { scope: "projects-poll" });

// --- Issues --------------------------------------------------------------------

on("GET", "issues", (c) => {
  const sp = c.url.searchParams;
  const filter = sp.get("filter") ? cleanFilter(JSON.parse(sp.get("filter") as string)) : filterFromParams(sp);
  const display = sp.get("display") ? { ...DEFAULT_DISPLAY, ...cleanDisplay(JSON.parse(sp.get("display") as string)) } : displayFromParams(sp);
  const limit = Number(sp.get("limit") ?? "50");
  return queryIssues(c.ctx, {
    filter,
    display,
    limit: Number.isFinite(limit) ? limit : 50,
    group: sp.has("inGroup") ? (sp.get("inGroup") as string) : undefined,
    cursor: sp.get("cursor"),
    today: sp.get("today") ?? undefined,
    dueFrom: sp.get("dueFrom") ?? undefined,
    dueTo: sp.get("dueTo") ?? undefined,
    scope: { projectId: sp.get("inProject") ?? undefined, cycleId: sp.get("inCycle") ?? undefined, teamId: sp.get("inTeam") ?? undefined },
  });
});
on("POST", "issues", (c) => createIssue(c.ctx, c.body));
on("POST", "issues/bulk", (c) => {
  const goals: GoalEvent[] = [];
  return { issues: updateIssues(c.ctx, c.body.ids, (c.body.patch ?? {}) as Body, goals), ...reached(c.ctx, goals) };
});
on("POST", "issues/delete", (c) => ({ deleted: deleteIssues(c.ctx, c.body.ids) }));
on("GET", "issues/:ref", (c) => {
  const id = issueRef(c);
  const detail = issueDetail(c.ctx, id);
  readIssueNotifications(c.ctx, id);
  return { ...detail, suggestions: suggestionsOf(c.ctx, id) };
});
on("POST", "suggestions/:id", (c) => ({ suggestions: resolveSuggestion(c.ctx, c.p.id, c.body.action) }));
on("GET", "issues/:ref/brief", (c) => getIssueBrief(c.ctx, issueRef(c)));
on("PATCH", "issues/:ref", (c) => {
  const goals: GoalEvent[] = [];
  return { ...updateIssue(c.ctx, issueRef(c), c.body, goals), ...reached(c.ctx, goals) };
});
on("DELETE", "issues/:ref", (c) => ({ deleted: deleteIssues(c.ctx, [issueRef(c)]) }));
on("POST", "issues/:ref/triage", (c) => triageIssue(c.ctx, c.p.ref, c.body));
on("POST", "issues/:ref/comments", (c) => addComment(c.ctx, issueRef(c), c.body));
on("POST", "issues/:ref/relations", (c) => ({ relations: addRelation(c.ctx, issueRef(c), c.body) }));
on("POST", "issues/:ref/subscribe", (c) => {
  setSubscribed(c.ctx, issueRef(c), c.body.on === true);
  return { ok: true };
});
on("POST", "issues/:ref/attachments", (c) => upload(c), { raw: true, scope: "projects-upload" });

on("PATCH", "comments/:id", (c) => editComment(c.ctx, c.p.id, c.body));
on("DELETE", "comments/:id", (c) => {
  deleteComment(c.ctx, c.p.id);
  return { ok: true };
});
on("POST", "comments/:id/reactions", (c) => toggleReaction(c.ctx, c.p.id, c.body.emoji));
on("DELETE", "relations/:id", (c) => {
  removeRelation(c.ctx, c.p.id);
  return { ok: true };
});
on("DELETE", "attachments/:id", (c) => {
  deleteAttachment(c.ctx, c.p.id);
  return { ok: true };
});
on("POST", "attachments/:id/link", (c) => signedLink(c.ctx, c.p.id));

// --- Teams, workflow, labels, fields -------------------------------------------

on("POST", "teams", (c) => createTeam(c.ctx, c.body, c.locale));
on("POST", "start", (c) => startProjects(c.ctx, c.locale));
on("PATCH", "teams/:id", (c) => updateTeam(c.ctx, c.p.id, c.body));
on("DELETE", "teams/:id", (c) => {
  deleteTeam(c.ctx, c.p.id);
  return { ok: true };
});
on("POST", "teams/:id/members", (c) => {
  const role = c.body.role;
  if (role !== null && role !== "lead" && role !== "member") throw bad("bad role");
  if (typeof c.body.userId !== "string") throw bad("bad user");
  return setTeamMember(c.ctx, c.p.id, c.body.userId, role);
});
on("POST", "teams/:id/statuses", (c) => createStatus(c.ctx, c.p.id, c.body));
on("POST", "teams/:id/cycles", (c) => createCycle(c.ctx, c.p.id, c.body));
on("PATCH", "statuses/:id", (c) => updateStatus(c.ctx, c.p.id, c.body));
on("DELETE", "statuses/:id", (c) => {
  deleteStatus(c.ctx, c.p.id, String(q(c, "moveTo") ?? ""));
  return { ok: true };
});
on("POST", "labels", (c) => createLabel(c.ctx, c.body));
on("PATCH", "labels/:id", (c) => updateLabel(c.ctx, c.p.id, c.body));
on("DELETE", "labels/:id", (c) => {
  deleteLabel(c.ctx, c.p.id);
  return { ok: true };
});
on("POST", "fields", (c) => createField(c.ctx, c.body));
on("PATCH", "fields/:id", (c) => updateField(c.ctx, c.p.id, c.body));
on("DELETE", "fields/:id", (c) => {
  deleteField(c.ctx, c.p.id);
  return { ok: true };
});

// --- Projects and cycles -------------------------------------------------------

on("GET", "projects", (c) => ({ projects: listProjects(c.ctx, { archived: q(c, "archived") === "1" }) }));
on("POST", "projects", (c) => createProject(c.ctx, c.body));
on("GET", "projects/:id", (c) => getProject(c.ctx, c.p.id));
on("PATCH", "projects/:id", (c) => updateProject(c.ctx, c.p.id, c.body));
on("DELETE", "projects/:id", (c) => {
  deleteProject(c.ctx, c.p.id);
  return { ok: true };
});
on("POST", "projects/:id/milestones", (c) => saveMilestone(c.ctx, c.p.id, c.body));
on("DELETE", "projects/:id/milestones/:mid", (c) => deleteMilestone(c.ctx, c.p.id, c.p.mid));
on("POST", "projects/:id/updates", (c) => addProjectUpdate(c.ctx, c.p.id, c.body));
on("DELETE", "updates/:id", (c) => {
  deleteProjectUpdate(c.ctx, c.p.id);
  return { ok: true };
});
on("GET", "cycles/:id", (c) => getCycle(c.ctx, c.p.id));
on("PATCH", "cycles/:id", (c) => updateCycle(c.ctx, c.p.id, c.body));
on("DELETE", "cycles/:id", (c) => {
  deleteCycle(c.ctx, c.p.id);
  return { ok: true };
});
on("POST", "cycles/:id/complete", (c) => completeCycle(c.ctx, c.p.id, typeof c.body.moveTo === "string" ? c.body.moveTo : null));

// --- Views, favorites, inbox, search -------------------------------------------

on("GET", "views", (c) => ({ views: listViews(c.ctx) }));
on("POST", "views", (c) => saveView(c.ctx, null, c.body));
on("PATCH", "views/:id", (c) => saveView(c.ctx, c.p.id, c.body));
on("DELETE", "views/:id", (c) => {
  deleteView(c.ctx, c.p.id);
  return { ok: true };
});
on("POST", "favorites", (c) => ({ favorites: setFavorite(c.ctx, c.body.kind, c.body.targetId, c.body.on !== false) }));
on("GET", "notifications", (c) => inbox(c.ctx, { archived: q(c, "archived") === "1", before: q(c, "before") ? Number(q(c, "before")) : undefined }));
on("POST", "notifications", (c) => ({ changed: markNotifications(c.ctx, c.body.ids, c.body.action, c.body.until), unread: unreadCount(c.ctx) }));
on("GET", "search", (c) => search(c.ctx, q(c, "q") ?? ""));
on("GET", "insights", (c) => insights(c.ctx, { teamId: q(c, "team"), projectId: q(c, "project"), weeks: q(c, "weeks"), today: q(c, "today") }));

// --- Assistant (rules; Jev for triage when the owner turned it on) --------------------------------------------------

on(
  "POST",
  "assist",
  (c) => {
    const b = c.body;
    const s = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
    switch (b.action) {
      case "describe":
        return assist.describe(s("request").slice(0, 500), c.locale);
      case "breakdown":
        return assist.breakdown(c.ctx, resolveIssueId(c.ctx, s("issueId")));
      case "digest":
        return assist.digest(c.ctx, resolveIssueId(c.ctx, s("issueId")));
      case "similar":
        return similarIssues(c.ctx, { title: s("title"), description: s("description").slice(0, 20_000), excludeId: s("excludeId") || null });
      case "fromDoc":
        return planFromDoc(c.ctx, s("noteId"));
      case "triage":
        return triageSmart(c.ctx, { title: s("title").slice(0, 300), description: s("description").slice(0, 20_000), teamId: s("teamId") || null });
      case "projectUpdate":
        return assist.projectUpdate(c.ctx, s("projectId"), c.locale);
      case "blockers":
        return assist.blockers(c.ctx, { projectId: s("projectId") || undefined, cycleId: s("cycleId") || undefined });
      case "cycleReport":
        return assist.cycleReport(c.ctx, s("cycleId"), c.locale);
      case "stale":
        return assist.stale(c.ctx, { days: Number(b.days) || 7, today: isDate(b.today) ? b.today : undefined });
      case "parseQuery": {
        const parsed = assist.parseQuery(c.ctx, s("text"));
        return { ...parsed, count: assist.previewQuery(c.ctx, parsed.filter, isDate(b.today) ? b.today : undefined) };
      }
      default:
        throw bad("unknown action");
    }
  },
  { scope: "projects-assist" }
);
on("POST", "from-doc", (c) => createFromDoc(c.ctx, c.body));
on("GET", "doc-conversions", (c) => ({ lines: pendingConversions(c.ctx, q(c, "note")) }));
on("POST", "doc-conversions/claim", (c) => ({ lines: claimConversions(c.ctx, c.body.note, c.body.blocks) }));

// Jev's autopilot follows new issues and comments (instrumentation starts it too).
startAutopilot();

// --- Uploads and downloads -----------------------------------------------------

async function upload(c: Call): Promise<unknown> {
  // Rights and the issue first: nothing touches the disk for a request that will be refused.
  needs(c.ctx, "edit");
  const id = issueState(c.ctx, issueRef(c)).id;
  const declared = Number(c.req.headers.get("content-length") ?? "0");
  if (declared > NOTE_LIMITS.uploadBytes) throw new PjError(413, "too large");
  let fileName = "file";
  try {
    fileName = decodeURIComponent(c.req.headers.get("x-file-name") ?? "file").slice(0, 200);
  } catch {
    // keep the default
  }
  const ext0 = uploadExt(fileName, c.req.headers.get("content-type") ?? "");
  if (!ext0) throw new PjError(415, "type not allowed");
  const buf = await c.req.arrayBuffer().catch(() => null);
  if (!buf || buf.byteLength === 0) throw bad("empty");
  if (buf.byteLength > NOTE_LIMITS.uploadBytes) throw new PjError(413, "too large");
  const payer = payerOf(c.ctx.wsId) as string;
  const { bytes, ext } = await compressImage(new Uint8Array(buf), ext0);
  if (bytes.byteLength > (await quotaLeft(payer))) throw new PjError(507, "quota");
  const saved = await saveNoteFile(bytes, ext);
  if ("error" in saved) throw new PjError(507, "storage full");
  try {
    return addAttachment(c.ctx, id, { name: fileName, stored: saved.name, bytes: bytes.byteLength, payer });
  } catch (e) {
    // Content-addressed: remove the bytes only if nobody else stores them.
    if (!sql("SELECT 1 FROM files WHERE name = ? LIMIT 1").get(saved.name)) await removeNoteFiles([saved.name]);
    throw e;
  }
}

const FILE_NO_STORE = { "cache-control": "private, no-store" };

async function streamFile(file: string, name: string, download: boolean): Promise<Response> {
  const t = attachmentType(file);
  if (!t || !/^[a-f0-9]{40}\.[a-z0-9]{1,5}$/.test(file)) return new Response("not found", { status: 404, headers: FILE_NO_STORE });
  const path = join(notesFilesDir(), file);
  try {
    const st = await stat(path);
    if (!st.isFile()) throw new Error("not a file");
    const headers: Record<string, string> = {
      "content-type": t.type,
      "content-length": String(st.size),
      // Private: no shared cache keeps a copy after access is revoked.
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
      "content-security-policy": file.endsWith(".pdf") ? "default-src 'none'; object-src 'self'; frame-ancestors 'self'" : "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox",
    };
    if (!t.inline || download) headers["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(name.slice(0, 150))}`;
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { headers });
  } catch {
    return new Response("not found", { status: 404, headers: FILE_NO_STORE });
  }
}

/** GET /api/projects/attachments/<id>: a member of the issue's workspace, or a valid signed link. */
async function download(req: Request, id: string): Promise<Response> {
  const url = new URL(req.url);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return fail(404, "not found");
  const dl = url.searchParams.get("download") !== null;
  if (url.searchParams.has("sig")) {
    if (!checkSignedLink(id, url.searchParams.get("exp"), url.searchParams.get("sig"))) return fail(403, "link expired");
    const a = attachmentById(id);
    return a ? streamFile(a.file, a.name, dl) : fail(404, "not found");
  }
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = sql("SELECT ws_id FROM pj_attachments WHERE id = ?").get(id) as { ws_id: string } | undefined;
  if (!ws) return fail(404, "not found");
  let a: ReturnType<typeof attachmentFor> = null;
  try {
    a = attachmentFor(ctxFor(me.user.id, ws.ws_id, "read"), id);
  } catch {
    a = null;
  }
  // Not a member or no access to the team: the same answer as "no such file".
  return a ? streamFile(a.file, a.name, dl) : fail(404, "not found");
}

// --- Dispatch ------------------------------------------------------------------

function match(method: string, segs: string[]): { route: Route; p: Record<string, string> } | null {
  for (const r of routes) {
    if (r.method !== method || r.path.length !== segs.length) continue;
    const p: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < segs.length; i++) {
      const want = r.path[i];
      if (want.startsWith(":")) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(segs[i])) {
          ok = false;
          break;
        }
        p[want.slice(1)] = segs[i];
      } else if (want !== segs[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route: r, p };
  }
  return null;
}

/** The client's tab id for event buses that skip echoes (x-zvena-origin; same check as lib/pulse/bus originOf). */
function originOf(req: Request): string | undefined {
  const o = req.headers.get("x-zvena-origin");
  return o && /^[A-Za-z0-9_-]{8,40}$/.test(o) ? o : undefined;
}

/** The interface language, decided the same way as on every zvena page. */
function localeOf(req: Request): string {
  const cookie = /(?:^|;\s*)zv_lang=([a-z]{2})/.exec(req.headers.get("cookie") ?? "")?.[1];
  return resolveLocale(cookie, parseAcceptLanguage(req.headers.get("accept-language")));
}

function langOf(req: Request): "ru" | "en" {
  // Projects' server texts (summaries, drafts) exist in Russian and English; the interface follows every language.
  return enRu(localeOf(req));
}

export async function handle(req: Request, method: Method, segs: string[]): Promise<Response> {
  if (method === "GET" && segs.length === 2 && segs[0] === "attachments") {
    const rl = rateLimited(req, "projects-file", 600);
    return rl ?? download(req, segs[1]);
  }
  const m = match(method, segs);
  if (!m) return fail(404, "not found");
  const rl = rateLimited(req, m.route.scope ?? "projects", m.route.scope === "projects-upload" ? 60 : m.route.scope === "projects-assist" ? 60 : 900);
  if (rl) return rl;
  if (method !== "GET") {
    const badOrigin = crossSite(req);
    if (badOrigin) return badOrigin;
  }
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const url = new URL(req.url);
  try {
    const ctx = ctxFor(me.user.id, url.searchParams.get("ws"), "read");
    ctx.origin = originOf(req);
    let body: Body = {};
    if (!m.route.raw && method !== "GET" && method !== "DELETE") {
      const parsed = await readJsonCapped(req, 2_000_000);
      if (!parsed.ok) return fail(parsed.status, parsed.status === 413 ? "request too large" : "bad request");
      if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return fail(400, "bad request");
      body = parsed.value as Body;
    }
    const out = await m.route.run({ req, url, ctx, p: m.p, body, lang: langOf(req), locale: localeOf(req) });
    return json(out ?? { ok: true });
  } catch (e) {
    if (e instanceof PjError) return json({ error: e.code, ...(e.detail && e.detail !== e.code ? { detail: e.detail } : {}) }, e.status);
    if (e instanceof LimitError) return json({ error: `limit: ${e.what}` }, 409);
    if (e instanceof SyntaxError) return fail(400, "bad request");
    console.error(`[projects] ${method} ${m.route.path.join("/")} failed (${e instanceof Error ? e.name : "error"})`);
    return fail(500, "internal error");
  }
}
