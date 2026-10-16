import { readLocale, parseAcceptLanguage } from "@/lib/locale-server";
import { crossSite, currentUser, fail, json } from "@/lib/http";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { roleIn } from "@/lib/workspaces";
import { AccountError, cleanSignature, connectAccount, removeAccount, updateAccount } from "@/lib/mail-client/accounts";
import { ActionError, applyAction, isAction } from "@/lib/mail-client/actions";
import { ComposeError, cleanDraft } from "@/lib/mail-client/compose";
import { suggestContacts } from "@/lib/mail-client/contacts";
import { DocsError, docsAccessFor, issueFromThread, saveThreadToDocs } from "@/lib/mail-client/docs";
import { deleteDraft, draftFromMessage, draftMsgids, draftOf, draftsOf, saveDraft } from "@/lib/mail-client/drafts";
import { createView, deleteSnippet, deleteView, prefsOf, saveSnippet, setPrefs, snippetsOf, updateView, viewOf, viewsOf } from "@/lib/mail-client/prefs";
import { searchFilter } from "@/lib/mail-client/search";
import { cancelSend, outboxOf, queueSend, retrySend } from "@/lib/mail-client/send";
import { mailDb } from "@/lib/mail-client/schema";
import {
  accountsOf,
  allowImages,
  createManualLabel,
  deleteManualLabel,
  labelsOf,
  listThreads,
  ownMessage,
  publicAccount,
  threadOf,
  unreadCounts,
  updateManualLabel,
} from "@/lib/mail-client/store";
import { ensureWorker, workerOf } from "@/lib/mail-client/worker";
import type { ViewFilter } from "@/lib/mail-client/views";
import { NOTE_ID_RE } from "@/lib/notes/types";
import { testStand } from "@/lib/mail-client/guard";

export const dynamic = "force-dynamic";

// zvena Mail's API. Mail is personal: every route acts for the signed-in
// person on their own mailboxes, and every id (account, conversation,
// message, label, view, draft) is looked up together with its owner, so
// another person's id is "not found". Writes are same-origin only (CSRF).
// Mailbox passwords go in once (connect, change password) and never come out.
//
//   GET    boot?ws                      accounts, labels, views, settings, snippets, drafts, outbox, counts
//   GET    threads?view|label|q&account&offset   a page of conversations
//   GET    thread/<id>                  a conversation with its messages
//   GET    counts                       unread per box
//   GET    contacts?q                   address suggestions (people one wrote to, workspace members)
//   GET    docs-access?ws&note&emails   recipients who cannot open a Docs page
//   POST   accounts {preset, email, name, password, imap?, smtp?}   connect (both servers checked first)
//   PATCH  accounts/<id> {name?, signature?, color?, password?}
//   DELETE accounts/<id>                disconnect (the mail on the server stays)
//   POST   accounts/<id>/sync           sync now
//   POST   actions {threads|messages, action, until?, label?}
//   POST   views · PATCH views/<id> · DELETE views/<id>
//   POST   labels · PATCH labels/<id> · DELETE labels/<id>
//   POST   snippets · PATCH snippets/<id> · DELETE snippets/<id>
//   PATCH  prefs
//   PUT    drafts/<id> · DELETE drafts/<id> · POST drafts/from-message {message}
//   POST   send {draft, sendAt?, ws?, forwardAttachments?}   → the outbox (undo send, send later)
//   DELETE outbox/<id>                  undo / cancel: the draft comes back
//   POST   outbox/<id>/retry
//   POST   senders {message}            always show the images of this message's sender
//   POST   docs {thread, ws, parent?}   save to Documents
//   POST   issue {thread, ws, title?, teamId?, projectId?}   turn into a Projects issue
// The message frame, images, attachments and uploads have routes of their own
// (body/, img/, att/, upload/), outside the page proxy (their own CSP).

type Params = { params: Promise<{ path: string[] }> };
type Me = { id: string; name: string; email?: string };

const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;

function who(req: Request): { me: Me; setCookie?: string } | Response {
  const s = currentUser(req);
  if (!s) return fail(401, "unauthorized");
  return { me: { id: s.user.id, name: s.user.name, ...(s.user.email ? { email: s.user.email } : {}) }, setCookie: s.setCookie };
}

function answer(body: unknown, setCookie?: string, status = 200): Response {
  const res = json(body, status);
  if (setCookie) res.headers.append("set-cookie", setCookie);
  return res;
}

async function body(req: Request, max = 256_000): Promise<Record<string, unknown> | Response> {
  const p = await readJsonCapped(req, max);
  if (!p.ok) return fail(p.status, "bad request");
  return p.value && typeof p.value === "object" && !Array.isArray(p.value) ? (p.value as Record<string, unknown>) : fail(400, "bad request");
}

function failure(e: unknown, what: string): Response {
  if (e instanceof AccountError || e instanceof ActionError || e instanceof ComposeError || e instanceof DocsError) return fail(e.status, e.code);
  console.error(`[mail] ${what} failed (${e instanceof Error ? e.name : "error"})`);
  return fail(500, "internal error");
}

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && ID_RE.test(x)).slice(0, 500) : []);

/** The filter of a list request: a view, a label, or a search; one mailbox or all. */
function filterOf(userId: string, u: URL): ViewFilter | null {
  const q = u.searchParams.get("q");
  const label = u.searchParams.get("label");
  const view = u.searchParams.get("view") || "inbox";
  let f: ViewFilter | null;
  if (q) f = searchFilter(userId, q);
  else if (label) f = ID_RE.test(label) ? { box: "any", labels: [label] } : null;
  else f = viewOf(userId, view)?.filter ?? null;
  const account = u.searchParams.get("account");
  if (f && account && ID_RE.test(account)) f = { ...f, account };
  return f;
}

export async function GET(req: Request, { params }: Params) {
  const path = (await params).path;
  const rl = rateLimited(req, "mail", 900);
  if (rl) return rl;
  const w = who(req);
  if (w instanceof Response) return w;
  const { me, setCookie } = w;
  const u = new URL(req.url);
  try {
    mailDb();
    switch (path[0]) {
      case "boot": {
        const ws = u.searchParams.get("ws");
        // Mail notifications go to the Inbox of the workspace Mail was last opened in.
        if (ws && roleIn(me.id, ws) && prefsOf(me.id).ws !== ws) setPrefs(me.id, { ws });
        const accounts = accountsOf(me.id);
        for (const a of accounts) ensureWorker(a.id);
        return answer(
          {
            me,
            accounts: accounts.map(publicAccount),
            labels: labelsOf(me.id),
            views: viewsOf(me.id),
            prefs: prefsOf(me.id),
            snippets: snippetsOf(me.id),
            drafts: draftsOf(me.id),
            outbox: outboxOf(me.id),
            counts: unreadCounts(me.id),
            // A test stand may connect to its local test server without TLS (lib/mail-client/guard.ts).
            stand: testStand(),
          },
          setCookie
        );
      }
      case "threads": {
        const f = filterOf(me.id, u);
        if (!f) return fail(404, "no such view");
        const offset = Number(u.searchParams.get("offset")) || 0;
        return answer(listThreads(me.id, f, { limit: 50, offset, exclude: draftMsgids(me.id) }), setCookie);
      }
      case "thread": {
        const t = threadOf(me.id, path[1], prefsOf(me.id).alwaysImages);
        return t ? answer(t, setCookie) : fail(404, "not found");
      }
      case "counts":
        return answer({ counts: unreadCounts(me.id), outbox: outboxOf(me.id), accounts: accountsOf(me.id).map(publicAccount) }, setCookie);
      case "contacts":
        return answer({ contacts: suggestContacts(me.id, u.searchParams.get("q") ?? "") }, setCookie);
      case "drafts":
        if (path[1]) {
          const d = ID_RE.test(path[1]) ? draftOf(me.id, path[1]) : null;
          return d ? answer(d, setCookie) : fail(404, "not found");
        }
        return answer({ drafts: draftsOf(me.id) }, setCookie);
      case "docs-access": {
        const ws = u.searchParams.get("ws") ?? "";
        const note = u.searchParams.get("note") ?? "";
        if (!roleIn(me.id, ws) || !NOTE_ID_RE.test(note)) return fail(403, "forbidden");
        const emails = (u.searchParams.get("emails") ?? "").split(",").filter(Boolean);
        const locale = readLocale(req.headers.get("cookie"), parseAcceptLanguage(req.headers.get("accept-language")));
        const r = docsAccessFor({ userId: me.id, wsId: ws, locale }, note, emails);
        return r ? answer(r, setCookie) : fail(404, "not found");
      }
    }
    return fail(404, "not found");
  } catch (e) {
    return failure(e, `GET ${path[0]}`);
  }
}

async function write(req: Request, method: "POST" | "PATCH" | "PUT" | "DELETE", path: string[]): Promise<Response> {
  const bad = crossSite(req);
  if (bad) return bad;
  const rl = rateLimited(req, "mail-write", 300);
  if (rl) return rl;
  const w = who(req);
  if (w instanceof Response) return w;
  const { me, setCookie } = w;
  mailDb();
  const [route, id, sub] = path;
  const ok = (v: unknown = { ok: true }) => answer(v, setCookie);
  const b = method === "DELETE" ? {} : await body(req, route === "send" || route === "drafts" ? 2_500_000 : 256_000);
  if (b instanceof Response) return b;
  const locale = readLocale(req.headers.get("cookie"), parseAcceptLanguage(req.headers.get("accept-language")));
  try {
    switch (route) {
      case "accounts": {
        if (method === "POST" && !id) {
          // Each try signs in to two servers: few a minute.
          const limit = rateLimited(req, "mail-connect", 10);
          if (limit) return limit;
          return ok({ account: publicAccount(await connectAccount(me.id, b)) });
        }
        if (method === "POST" && id && sub === "sync") {
          const a = accountsOf(me.id).find((x) => x.id === id);
          if (!a) return fail(404, "not found");
          (workerOf(a.id) ?? ensureWorker(a.id))?.poke();
          return ok();
        }
        if (method === "PATCH" && id) return ok({ account: publicAccount(await updateAccount(me.id, id, b)) });
        if (method === "DELETE" && id) return removeAccount(me.id, id) ? ok() : fail(404, "not found");
        break;
      }
      case "actions": {
        if (method !== "POST" || !isAction(b.action)) break;
        const n = applyAction(me.id, { threads: ids(b.threads), messages: ids(b.messages) }, b.action, { until: b.until, label: b.label });
        return ok({ changed: n });
      }
      case "views": {
        if (method === "POST" && !id) {
          const v = createView(me.id, b);
          return v ? ok({ view: v }) : fail(400, "bad view");
        }
        if (method === "PATCH" && id) return updateView(me.id, id, b) ? ok({ views: viewsOf(me.id) }) : fail(404, "not found");
        if (method === "DELETE" && id) return deleteView(me.id, id) ? ok() : fail(404, "not found");
        break;
      }
      case "labels": {
        if (method === "POST" && !id) {
          if (typeof b.name !== "string" || !b.name.trim()) return fail(400, "name required");
          return ok({ label: createManualLabel(me.id, b.name, typeof b.color === "string" && /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : "") });
        }
        if (method === "PATCH" && id) return updateManualLabel(me.id, id, { name: typeof b.name === "string" ? b.name : undefined, color: typeof b.color === "string" && /^(#[0-9a-f]{6})?$/i.test(b.color) ? b.color : undefined }) ? ok() : fail(404, "not found");
        if (method === "DELETE" && id) return deleteManualLabel(me.id, id) ? ok() : fail(404, "not found");
        break;
      }
      case "snippets": {
        if ((method === "POST" && !id) || (method === "PATCH" && id)) {
          const s = saveSnippet(me.id, id ?? null, b, cleanSignature);
          return s ? ok({ snippet: s }) : fail(400, "bad snippet");
        }
        if (method === "DELETE" && id) return deleteSnippet(me.id, id) ? ok() : fail(404, "not found");
        break;
      }
      case "prefs":
        if (method === "PATCH") return ok({ prefs: setPrefs(me.id, b) });
        break;
      case "drafts": {
        if (method === "POST" && id === "from-message") {
          const d = await draftFromMessage(me.id, typeof b.message === "string" ? b.message : "");
          return d ? ok({ draft: d }) : fail(404, "not found");
        }
        if (!id || !ID_RE.test(id)) break;
        if (method === "PUT") {
          const d = saveDraft(me.id, id, b);
          return d ? ok({ draft: d }) : fail(404, "not found");
        }
        if (method === "DELETE") return deleteDraft(me.id, id) ? ok() : fail(404, "not found");
        break;
      }
      case "send": {
        if (method !== "POST") break;
        const limit = rateLimited(req, "mail-send", 30);
        if (limit) return limit;
        const draftId = typeof (b.draft as { id?: unknown } | undefined)?.id === "string" && ID_RE.test((b.draft as { id: string }).id) ? (b.draft as { id: string }).id : null;
        if (!draftId) return fail(400, "bad draft");
        const item = await queueSend(me.id, me.name, {
          draft: cleanDraft(b.draft, draftId),
          ...(typeof b.sendAt === "number" ? { sendAt: b.sendAt } : {}),
          ...(typeof b.ws === "string" ? { ws: b.ws } : {}),
          forwardAttachments: ids(b.forwardAttachments),
        });
        return ok({ outbox: item });
      }
      case "outbox": {
        if (!id || !ID_RE.test(id)) break;
        if (method === "DELETE") {
          const d = cancelSend(me.id, id);
          return d ? ok({ draft: d }) : fail(409, "already sent");
        }
        if (method === "POST" && sub === "retry") return retrySend(me.id, id) ? ok() : fail(404, "not found");
        break;
      }
      case "senders": {
        if (method !== "POST") break;
        const m = typeof b.message === "string" ? ownMessage(me.id, b.message) : null;
        if (!m) return fail(404, "not found");
        allowImages(me.id, m.from_addr);
        return ok();
      }
      case "docs":
      case "issue": {
        if (method !== "POST") break;
        const ws = typeof b.ws === "string" ? b.ws : "";
        if (!roleIn(me.id, ws)) return fail(403, "forbidden");
        const v = { userId: me.id, wsId: ws, locale, name: me.name };
        if (route === "docs") return ok(await saveThreadToDocs(v, b.thread, typeof b.parent === "string" && NOTE_ID_RE.test(b.parent) ? b.parent : null));
        return ok({ card: await issueFromThread(v, b) });
      }
    }
    return fail(404, "not found");
  } catch (e) {
    return failure(e, `${method} ${route}`);
  }
}

export async function POST(req: Request, { params }: Params) {
  return write(req, "POST", (await params).path);
}
export async function PATCH(req: Request, { params }: Params) {
  return write(req, "PATCH", (await params).path);
}
export async function PUT(req: Request, { params }: Params) {
  return write(req, "PUT", (await params).path);
}
export async function DELETE(req: Request, { params }: Params) {
  return write(req, "DELETE", (await params).path);
}
