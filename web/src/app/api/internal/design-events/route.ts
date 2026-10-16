import { createHash, timingSafeEqual } from "node:crypto";
import { designMentions } from "@/lib/eco/design";
import { userIdOfLogin } from "@/lib/penpot";
import { emit } from "@/lib/pulse/bus";
import { readJsonCapped } from "@/lib/safe-json";
import { sql } from "@/lib/store";

export const dynamic = "force-dynamic";

// POST /api/internal/design-events   x-zvena-key: ZVENA_INTERNAL_KEY
// { "events": [{ "team": "<penpot team uuid>", "file": "<file uuid>", "name": "update-file",
//                "login": "u-<id>@users.zvena.app" }, …] }   (up to 100)
// → { delivered: n }
//
// Design's backend (app.zvena.*) reports what changed in a team; the team's
// workspace hears it on its pulse as type "design" (ref = the file), so open
// Documents, Projects and dashboards refresh what they show of the Board, and
// reactions can judge it. A file being dragged around reports many times a
// second: each file is announced at most every 300 ms (the last change always
// gets through). Comment events are throttled apart from edits, so a comment
// saved together with the file is never folded into an "update-file".
// Internal: the shared key; ids only, never design content.

const THROTTLE_MS = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[a-z][a-z0-9-]{0,60}$/;

function keyOk(req: Request): boolean {
  const want = process.env.ZVENA_INTERNAL_KEY || "";
  const got = req.headers.get("x-zvena-key") || "";
  if (want.length < 32) return false;
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(want), h(got));
}

interface Pending {
  until: number;
  trailing: { name: string; by: string } | null;
  timer: ReturnType<typeof setTimeout> | null;
}
const KEY = Symbol.for("zvena.pulse.design");
const g = globalThis as unknown as Record<symbol, Map<string, Pending> | undefined>;
const recent: Map<string, Pending> = (g[KEY] ??= new Map());

function announce(ws: string, file: string, name: string, by: string, thread: string | null = null): void {
  // A thread resolved or reopened is its own news (Jev's hub follows that thread): never folded into another's.
  const k = `${ws}:${file}:${name === "update-comment-thread" && thread ? `thread:${thread}` : /comment/.test(name) ? "comment" : "file"}`;
  const data = (n: string) => ({ event: n, ...(n === "update-comment-thread" && thread ? { thread } : {}) });
  const now = Date.now();
  const p = recent.get(k);
  if (p && now < p.until) {
    p.trailing = { name, by };
    p.timer ??= setTimeout(() => {
      const last = p.trailing;
      p.trailing = null;
      p.timer = null;
      p.until = Date.now() + THROTTLE_MS;
      if (last) emit(ws, { type: "design", ref: file, by: last.by, data: data(last.name) });
    }, p.until - now);
    return;
  }
  recent.set(k, { until: now + THROTTLE_MS, trailing: null, timer: null });
  if (recent.size > 5000) for (const [key, v] of recent) if (v.until < now && !v.timer) recent.delete(key);
  emit(ws, { type: "design", ref: file, by, data: data(name) });
}

export async function POST(req: Request) {
  if (!keyOk(req)) return Response.json({ error: "forbidden" }, { status: 403 });
  const parsed = await readJsonCapped(req, 64_000);
  if (!parsed.ok) return Response.json({ error: "bad request" }, { status: parsed.status });
  const events = (parsed.value as { events?: unknown })?.events;
  if (!Array.isArray(events)) return Response.json({ error: "bad request" }, { status: 400 });
  let delivered = 0;
  const wsOf = new Map<string, string[]>();
  for (const raw of events.slice(0, 100)) {
    const e = (raw ?? {}) as { team?: unknown; file?: unknown; name?: unknown; login?: unknown; thread?: unknown; comment?: unknown; mentions?: unknown };
    if (typeof e.team !== "string" || !UUID.test(e.team) || typeof e.file !== "string" || !UUID.test(e.file)) continue;
    const name = typeof e.name === "string" && NAME.test(e.name) ? e.name : "change";
    let list = wsOf.get(e.team);
    if (!list) {
      list = (sql("SELECT id FROM workspaces WHERE penpot_team_id = ?").all(e.team.toLowerCase()) as { id: string }[]).map((r) => r.id);
      wsOf.set(e.team, list);
    }
    const by = (typeof e.login === "string" && userIdOfLogin(e.login)) || "design";
    // People mentioned in a comment (never its author): their Inbox, read as each of them.
    const mentions = Array.isArray(e.mentions) ? e.mentions.filter((m): m is string => typeof m === "string" && m.length <= 200).slice(0, 50) : [];
    const thread = typeof e.thread === "string" && UUID.test(e.thread) ? e.thread.toLowerCase() : null;
    const comment = typeof e.comment === "string" && UUID.test(e.comment) ? e.comment.toLowerCase() : null;
    for (const ws of list) {
      announce(ws, e.file.toLowerCase(), name, by, thread);
      if (thread && mentions.length) void designMentions(ws, { file: e.file.toLowerCase(), thread, comment, logins: mentions, by: by === "design" ? null : by }).catch(() => {});
      delivered++;
    }
  }
  return Response.json({ delivered }, { headers: { "cache-control": "no-store" } });
}
