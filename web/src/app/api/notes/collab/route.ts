import { crossSite, currentUser, fail, json } from "@/lib/http";
import { atLeast, docsPresence, pageLevel } from "@/lib/notes/access";
import { applyAwareness, applyUpdate, claim, findRoom, join, leave, openRoom } from "@/lib/notes/collab";
import { COLLAB_MAX_POST, fromBase64 } from "@/lib/notes/collab-shared";
import "@/lib/notes/reactions";
import { NOTE_ID_RE } from "@/lib/notes/types";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { sql } from "@/lib/store";
import { can } from "@/lib/workspaces";
import { readSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Co-editing of a page (src/lib/notes/collab.ts).
// GET  ?ws=&id=&client=  → SSE: "init" (the document, who is here), then
//                          "update" / "awareness" from the others, "gone".
//                          Members of the workspace.
// POST ?ws=&id=          { client, update?, awareness?, claim? } → { ok, granted? }
//                          Updates from editors; awareness (cursors, who is
//                          here) from anyone in the page.

const CLIENT_RE = /^[A-Za-z0-9_-]{8,40}$/;
const HEARTBEAT = 20_000;

function target(req: Request): { ws: string; id: string } | null {
  const u = new URL(req.url);
  const ws = u.searchParams.get("ws") ?? "";
  const id = u.searchParams.get("id") ?? "";
  return NOTE_ID_RE.test(id) ? { ws, id } : null;
}

/** A page of the workspace (not deleted, not a database): what a room is opened for. */
function pageExists(ws: string, id: string): boolean {
  const r = sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, id) as { json: string | null } | undefined;
  if (!r?.json) return false;
  try {
    return (JSON.parse(r.json) as { kind?: string }).kind === "page";
  } catch {
    return false;
  }
}

/**
 * May the person join this page's session, and edit in it? Their level on
 * the page (a share counts, Private and restricted pages stay closed); a
 * page created a moment ago, before its first sync reaches the server, by
 * a member with an editing role. null: no access.
 */
function editLevel(userId: string, ws: string, id: string): boolean | null {
  if (pageExists(ws, id)) {
    const level = pageLevel(userId, ws, id);
    return level === null ? null : atLeast(level, "edit");
  }
  const presence = docsPresence(userId, ws);
  if (!presence?.role || !can.edit(presence.role) || sql("SELECT 1 FROM notes WHERE ws = ? AND id = ?").get(ws, id)) return null;
  return true;
}

/** Can comment (or more) on a page that exists: may mark the text of their own discussions. */
function commentLevel(userId: string, ws: string, id: string): boolean {
  if (!pageExists(ws, id)) return false;
  const level = pageLevel(userId, ws, id);
  return level !== null && atLeast(level, "comment");
}

export async function GET(req: Request) {
  const rl = rateLimited(req, "notes-collab-open");
  if (rl) return rl;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const t = target(req);
  const client = new URL(req.url).searchParams.get("client") ?? "";
  if (!t || !CLIENT_RE.test(client)) return fail(400, "bad request");
  const mayEdit = editLevel(me.user.id, t.ws, t.id);
  if (mayEdit === null) return fail(403, "forbidden");
  const mayComment = !mayEdit && commentLevel(me.user.id, t.ws, t.id);

  const enc = new TextEncoder();
  const cookie = req.headers.get("cookie");
  const room = openRoom(t.ws, t.id);
  let stop = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          closed = true;
        }
      };
      const { conn, init } = join(room, {
        id: client,
        userId: me.user.id,
        mayEdit,
        mayComment,
        send: (event, data) => write(`event: ${event}\ndata: ${data}\n\n`),
        close: () => stop(),
      });
      write(`retry: 3000\nevent: init\ndata: ${JSON.stringify(init)}\n\n`);
      // A comment line every 20 s keeps proxies (Cloudflare drops idle streams at 100 s) from closing it;
      // each beat also re-checks the reader (a change no announcement covered: a group, a teamspace, a session ended).
      const hb = setInterval(() => {
        if (!pageLevel(me.user.id, t.ws, t.id) || !readSession(cookie)) return stop();
        write(": ping\n\n");
      }, HEARTBEAT);
      stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(hb);
        if (room.conns.get(conn.id) === conn) leave(room, conn.id);
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };
      req.signal.addEventListener("abort", () => stop(), { once: true });
    },
    cancel() {
      stop();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}

export async function POST(req: Request) {
  const rl = rateLimited(req, "notes-collab");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const t = target(req);
  if (!t) return fail(400, "bad request");
  const mayEdit = editLevel(me.user.id, t.ws, t.id);
  const parsed = await readJsonCapped(req, COLLAB_MAX_POST + 2_000);
  if (!parsed.ok) return fail(parsed.status, parsed.status === 413 ? "request too large" : "bad request");
  const body = parsed.value as { client?: unknown; update?: unknown; awareness?: unknown; claim?: unknown };
  if (mayEdit === null) {
    // A page just turned into a database (Turn into wiki) ends its session: the goodbye racing
    // that (a cursor, nothing written) has nothing left to do. Anything else is refused.
    if (!body.update && body.claim !== true && pageLevel(me.user.id, t.ws, t.id)) return json({ ok: true });
    return fail(403, "forbidden");
  }
  const client = typeof body.client === "string" && CLIENT_RE.test(body.client) ? body.client : "";
  const room = client ? findRoom(t.ws, t.id) : undefined;
  const conn = room?.conns.get(client);
  // The stream joins first; a POST for a stream that is gone asks the browser to reconnect.
  if (!room || !conn) {
    // A goodbye (cursor only) racing its own stream's close has nothing left to do.
    if (!body.update && body.claim !== true) return json({ ok: true });
    return fail(409, "not joined");
  }
  if (conn.userId !== me.user.id) return fail(403, "forbidden");
  let granted: boolean | undefined;
  try {
    if (typeof body.update === "string" && body.update) {
      // The level is checked again: it may have been lowered since the stream opened.
      if (!mayEdit && !(conn.mayComment && commentLevel(me.user.id, t.ws, t.id))) return fail(403, "read only");
      const r = applyUpdate(room, client, fromBase64(body.update));
      if (r === "forbidden") return fail(403, "read only");
      if (r === "too large") return fail(413, "document too large");
      if (r === "bad") return fail(400, "bad update");
    }
    if (typeof body.awareness === "string" && body.awareness) applyAwareness(room, client, fromBase64(body.awareness));
    if (body.claim === true) granted = mayEdit && claim(room, client);
  } catch {
    return fail(400, "bad request");
  }
  return json({ ok: true, ...(granted !== undefined ? { granted } : {}) });
}
