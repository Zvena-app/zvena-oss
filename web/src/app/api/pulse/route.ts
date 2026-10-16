import { readSession } from "@/lib/auth";
import { currentUser, fail } from "@/lib/http";
import { AccessResolver, docsPresence } from "@/lib/notes/access";
import { lastId, listen, streams, visibleTo, type PulseEvent } from "@/lib/pulse/bus";
import { keyVisible } from "@/lib/eco/visibility";
import { rateLimited } from "@/lib/rate-limit";

/** A notes event as each person may hear it ("<event id>|<user id>" → the event, narrowed, or null: nothing). */
const narrowed = new Map<string, PulseEvent | null>();

export const dynamic = "force-dynamic";

// GET /api/pulse?ws=<id> → text/event-stream of the workspace's changes (any member).
//
//   event: hello   data: {"id":<last id>}       on (re)connect: pull what you missed
//   id: <n>        data: <PulseEvent>           something changed: pull it
//   : ping                                      every 20 s (Cloudflare closes idle streams at 100 s)
//
// The stream closes itself when the session ends or the member leaves the
// workspace (checked every 30 s); EventSource then reconnects, and an
// answer of 401/403 stops it for good.

const PING_MS = 20_000;
const CHECK_MS = 30_000;
/** Open tabs per account (the rest get 429 and fall back to polling). */
const PER_USER = 24;

const KEY = Symbol.for("zvena.pulse.perUser");
const g = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
const perUser: Map<string, number> = (g[KEY] ??= new Map());

export async function GET(req: Request) {
  const rl = rateLimited(req, "pulse", 60);
  if (rl) return rl;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws");
  // Members, and guests (people outside the workspace shared some of its pages: Documents).
  const presence = docsPresence(me.user.id, ws);
  if (!presence) return fail(403, "forbidden");
  const userId = me.user.id;
  const guest = presence.guest;
  if ((perUser.get(userId) ?? 0) >= PER_USER) return fail(429, "too many streams");
  perUser.set(userId, (perUser.get(userId) ?? 0) + 1);
  const cookie = req.headers.get("cookie");
  const enc = new TextEncoder();

  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const write = (s: string) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          close();
        }
      };
      const unlisten = listen(ws as string, (e: PulseEvent) => {
        // Products hide what this person may not see (private teams, hidden objects).
        if (!visibleTo(userId, e)) return;
        // A guest hears only about the pages shared with them, and their own Inbox.
        if (guest) {
          if (e.type === "inbox") {
            if (e.ref !== userId) return;
          } else if (e.type === "notes" || e.type === "doc") {
            const all = e.ref ? [e.ref] : (e.refs ?? []);
            // A poke naming no page (access changed somewhere: lib/notes/access.ts) goes to everyone.
            if (all.length > 0) {
              const acc = new AccessResolver(ws as string, userId);
              const ids = all.filter((id) => acc.level(id) !== null);
              if (ids.length === 0) return;
              e = { ...e, ref: ids.length === 1 ? ids[0] : undefined, refs: ids.length > 1 ? ids : undefined };
            }
          } else return;
        } else if (e.type === "notes" || e.type === "doc") {
          // A member hears only about pages they may open: a private page's id (and who
          // edited it) is not everyone's news. Worked out once per person per event (several tabs).
          const memo = `${e.id}|${userId}`;
          let out = narrowed.get(memo);
          if (out === undefined) {
            const all = e.ref ? [e.ref] : (e.refs ?? []);
            const ids = all.filter((id) => keyVisible(userId, ws as string, `note:${id}`));
            out = all.length > 0 && ids.length === 0 ? null : ids.length === all.length ? e : { ...e, ref: ids.length === 1 ? ids[0] : undefined, refs: ids.length > 1 ? ids : undefined };
            if (narrowed.size > 5000) narrowed.clear();
            narrowed.set(memo, out);
          }
          if (!out) return;
          e = out;
        }
        write(`id: ${e.id}\ndata: ${JSON.stringify({ type: e.type, ref: e.ref, refs: e.refs, origin: e.origin, by: e.by, at: e.at, data: e.data })}\n\n`);
      });
      const ping = setInterval(() => write(": ping\n\n"), PING_MS);
      const check = setInterval(() => {
        const u = readSession(cookie);
        if (!u || u.id !== userId || !docsPresence(userId, ws)) close();
      }, CHECK_MS);
      function close() {
        if (!open) return;
        open = false;
        clearInterval(ping);
        clearInterval(check);
        unlisten();
        req.signal.removeEventListener("abort", close);
        const n = (perUser.get(userId) ?? 1) - 1;
        if (n > 0) perUser.set(userId, n);
        else perUser.delete(userId);
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      }
      cleanup = close;
      req.signal.addEventListener("abort", close, { once: true });
      // retry: how soon EventSource reconnects after a drop (ms).
      write(`retry: 1500\nevent: hello\ndata: ${JSON.stringify({ id: lastId(), streams: streams(ws as string) })}\n\n`);
    },
    cancel() {
      cleanup();
    },
  });

  const headers = new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    // no-transform: no proxy (Caddy, Cloudflare, Next) may compress or buffer it.
    "cache-control": "private, no-cache, no-store, no-transform",
    "x-accel-buffering": "no",
  });
  if (me.setCookie) headers.append("set-cookie", me.setCookie);
  return new Response(stream, { headers });
}
