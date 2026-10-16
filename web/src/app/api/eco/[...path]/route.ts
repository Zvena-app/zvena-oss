import { config } from "@/lib/config";
import { EcoError, designFor, designForIssue, docFor, docForIssue, issueFromDoc, link, setIssueDone, unlink, type Actor } from "@/lib/eco/actions";
import { issueList, projectOptions } from "@/lib/eco/lists";
import { cardsFor } from "@/lib/eco/cards";
import { issueFromComment, wsOfTeam } from "@/lib/eco/design";
import { inboxOf, markInbox, unreadOf } from "@/lib/eco/inbox";
import { relatedOf } from "@/lib/eco/related";
import { searchAll } from "@/lib/eco/search";
import { access, crossSite, currentUser, fail, json, type Need } from "@/lib/http";
import { readLocale, parseAcceptLanguage } from "@/lib/locale-server";
import { PjError } from "@/lib/projects/core";
import { docsPresence } from "@/lib/notes/access";
import { originOf } from "@/lib/pulse/bus";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";

export const dynamic = "force-dynamic";

// The ecosystem API: links between products, cards, one search, conversions.
//
//   GET    /api/eco/related?ws&ref=<key>           what an object is linked with, both ways
//   POST   /api/eco/cards?ws        {refs: [...]}   cards for ref keys (live blocks, chips)
//   GET    /api/eco/search?ws&q                      documents, issues, projects, designs
//   POST   /api/eco/link?ws         {src, dst}      a link by hand
//   DELETE /api/eco/link?ws&src&dst                  …removed
//   POST   /api/eco/issue-from-doc?ws {note, title, teamId?, projectId?, assigneeId?, dueDate?}
//   POST   /api/eco/issue-done?ws   {issue, done}   an issue's checkbox, wherever it shows
//   POST   /api/eco/doc-for-issue?ws {issue}        a document that starts with the issue
//   POST   /api/eco/doc-for?ws      {ref}           …for an issue or a project (issue:<id> | project:<id>)
//   POST   /api/eco/design-for?ws   {ref}           a design file for an issue or a project
//   GET    /api/eco/issues?ws&project=<id>|&mine=1[&done=1]   a live list of issues (cards)
//   GET    /api/eco/projects?ws                     projects to pick from
//   POST   /api/eco/design-for-issue?ws {issue}     a design file named after the issue
//   GET    /api/eco/inbox?ws[&archived=1]           one Inbox: Documents', Design's and Projects' notifications
//   GET    /api/eco/unread?ws                       the Inbox's unread count
//   POST   /api/eco/inbox?ws        {ids | "all", action: read|unread|archive|unarchive}
//   POST   /api/eco/issue-from-design?ws {thread, title?, teamId?, projectId?}   a design comment → an issue
//
// Design calls the GET routes from its own origin with ?team=<its team id>
// instead of ?ws (it knows its team, not the workspace).
// Reading routes also answer Design (its own origin) — its quick actions find
// documents and issues, a frame shows its issues: CORS for that one origin,
// with the person's cookies. Writes stay same-origin.

type Params = { params: Promise<{ path: string[] }> };

function designOrigin(): string | null {
  try {
    return new URL(config.designUrl).origin;
  } catch {
    return null;
  }
}

function cors(req: Request, res: Response): Response {
  const origin = req.headers.get("origin");
  const allowed = designOrigin();
  if (origin && allowed && origin === allowed) {
    res.headers.set("access-control-allow-origin", origin);
    res.headers.set("access-control-allow-credentials", "true");
    res.headers.set("vary", "origin");
  }
  return res;
}

async function actor(req: Request, need: Need): Promise<Actor | Response> {
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const u = new URL(req.url);
  // Design's own origin names its team, and reaches that one workspace only (never ?ws=).
  const fromDesign = req.headers.get("origin") !== null && req.headers.get("origin") === designOrigin();
  const ws = fromDesign ? wsOfTeam(u.searchParams.get("team")) : u.searchParams.get("ws") || wsOfTeam(u.searchParams.get("team"));
  if (!ws || !access(me.user.id, ws, need)) return fail(403, "forbidden");
  const locale = readLocale(req.headers.get("cookie"), parseAcceptLanguage(req.headers.get("accept-language")));
  return { userId: me.user.id, name: me.user.name, wsId: ws, locale, origin: originOf(req) };
}

/** A guest of the workspace in ?ws= (some pages shared with them, no membership), or null. */
function guestActor(req: Request): Actor | null {
  const me = currentUser(req);
  const ws = new URL(req.url).searchParams.get("ws");
  if (!me || !ws || !docsPresence(me.user.id, ws)?.guest) return null;
  const locale = readLocale(req.headers.get("cookie"), parseAcceptLanguage(req.headers.get("accept-language")));
  return { userId: me.user.id, name: me.user.name, wsId: ws, locale, origin: originOf(req) };
}

async function body(req: Request): Promise<Record<string, unknown> | Response> {
  const parsed = await readJsonCapped(req, 64_000);
  if (!parsed.ok) return fail(parsed.status, "bad request");
  const v = parsed.value;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : fail(400, "bad request");
}

function failure(e: unknown, what: string): Response {
  if (e instanceof EcoError) return fail(e.status, e.code);
  if (e instanceof PjError) return json({ error: e.code, ...(e.detail && e.detail !== e.code ? { detail: e.detail } : {}) }, e.status);
  console.error(`[eco] ${what} failed (${e instanceof Error ? e.name : "error"})`);
  return fail(500, "internal error");
}

export async function OPTIONS(req: Request) {
  const res = new Response(null, { status: 204 });
  if (req.headers.get("origin") === designOrigin()) {
    res.headers.set("access-control-allow-methods", "GET");
    res.headers.set("access-control-max-age", "600");
  }
  return cors(req, res);
}

export async function GET(req: Request, { params }: Params) {
  const [route] = (await params).path;
  const rl = rateLimited(req, "eco", 600);
  if (rl) return cors(req, rl);
  // The unread badge asks on its own (pulse, focus): signed out meanwhile (signed out in another
  // tab, the account deleted) it is simply 0, not an error in the console.
  if (route === "unread" && !currentUser(req)) return cors(req, json({ unread: 0 }));
  // A guest of the workspace (pages shared with them, Documents) has an Inbox there too: their own items only.
  const guest = route === "unread" || route === "inbox" ? guestActor(req) : null;
  if (guest) {
    try {
      if (route === "unread") return cors(req, json({ unread: unreadOf(guest) }));
      return json(await inboxOf(guest, { archived: new URL(req.url).searchParams.get("archived") === "1" }));
    } catch (e) {
      return cors(req, failure(e, `GET ${route} (guest)`));
    }
  }
  const a = await actor(req, "read");
  // The badge's own poll for a workspace the person just left (or whose account is going): 0, quietly.
  if (a instanceof Response) return cors(req, route === "unread" && a.status === 403 ? json({ unread: 0 }) : a);
  const url = new URL(req.url);
  try {
    if (route === "related") return cors(req, json(await relatedOf(a, url.searchParams.get("ref") ?? "")));
    if (route === "search") return cors(req, json(await searchAll(a, url.searchParams.get("q") ?? "")));
    if (route === "inbox") return json(await inboxOf(a, { archived: url.searchParams.get("archived") === "1" }));
    if (route === "issues") return json({ cards: await issueList(a, { project: url.searchParams.get("project"), mine: url.searchParams.get("mine") === "1", done: url.searchParams.get("done") === "1" }) });
    if (route === "projects") return json({ projects: projectOptions(a) });
    if (route === "unread") return cors(req, json({ unread: unreadOf(a) }));
    return fail(404, "not found");
  } catch (e) {
    return cors(req, failure(e, `GET ${route}`));
  }
}

export async function POST(req: Request, { params }: Params) {
  const [route] = (await params).path;
  // Card loads have their own budget: a page full of live cards never blocks ticking a checkbox.
  const rl = route === "cards" || route === "inbox" ? rateLimited(req, "eco-read", 900) : rateLimited(req, "eco-write", 120);
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  // Reading cards and one's own Inbox needs no more than read access.
  const read = route === "cards" || route === "inbox";
  const a = (route === "inbox" ? guestActor(req) : null) ?? (await actor(req, read ? "read" : "edit"));
  if (a instanceof Response) return a;
  const b = await body(req);
  if (b instanceof Response) return b;
  try {
    switch (route) {
      case "cards": {
        const refs = Array.isArray(b.refs) ? b.refs.filter((r): r is string => typeof r === "string").slice(0, 200) : [];
        return json({ cards: await cardsFor(a, refs) });
      }
      case "link":
        return json({ ok: await link(a, b.src, b.dst) });
      case "issue-from-doc":
        return json({ card: await issueFromDoc(a, b) });
      case "issue-done":
        return json({ card: await setIssueDone(a, b.issue, b.done === true) });
      case "doc-for-issue":
        return json(await docForIssue(a, b.issue));
      case "design-for-issue":
        return json(await designForIssue(a, b.issue));
      case "doc-for":
        return json(await docFor(a, b.ref));
      case "design-for":
        return json(await designFor(a, b.ref));
      case "issue-from-design":
        return json({ card: await issueFromComment(a, b) });
      case "inbox": {
        const action = b.action;
        if (action !== "read" && action !== "unread" && action !== "archive" && action !== "unarchive") return fail(400, "bad action");
        return json({ changed: markInbox(a, b.ids, action), unread: unreadOf(a) });
      }
    }
    return fail(404, "not found");
  } catch (e) {
    return failure(e, `POST ${route}`);
  }
}

export async function DELETE(req: Request, { params }: Params) {
  const [route] = (await params).path;
  const rl = rateLimited(req, "eco-write", 120);
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const a = await actor(req, "edit");
  if (a instanceof Response) return a;
  const url = new URL(req.url);
  try {
    if (route === "link") return json({ ok: unlink(a, url.searchParams.get("src"), url.searchParams.get("dst")) });
    return fail(404, "not found");
  } catch (e) {
    return failure(e, `DELETE ${route}`);
  }
}
