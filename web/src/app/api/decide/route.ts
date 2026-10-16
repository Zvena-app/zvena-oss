import { access, crossSite, currentUser, fail, json } from "@/lib/http";
import { jevConfigured, jevStats } from "@/lib/decide/jev";
import { ID_RE } from "@/lib/decide/model";
import { decisionsOf, deleteReaction, metricsOf, newIngestToken, putMetric, reactionsOf, revokeIngestToken, saveReaction, setJev, settingsOf, visibleRules } from "@/lib/decide/engine";
import { proposeGoal } from "@/lib/decide/autogoal";
import { chartGoal, GOAL_OPS, goalsOf, setGoal, type GoalOp } from "@/lib/decide/goals";
import { hubOverview, setHubSettings } from "@/lib/decide/hub";
import { activityOf, resolve, settle } from "@/lib/decide/journal";
import { databasesFor, saveSource, sourceOf, visibleMetrics } from "@/lib/decide/sources";
import { listProjects } from "@/lib/projects/planning";
import { CalAccess } from "@/lib/calendar/access";
import { readableCalendars } from "@/lib/calendar/events";
import { accountsOf } from "@/lib/mail-client/store";
import { viewsOf as mailViewsOf } from "@/lib/mail-client/prefs";
import { ctxFor } from "@/lib/projects/core";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { audit } from "@/lib/store";

export const dynamic = "force-dynamic";

// Jev in a workspace: reactions, goals, live numbers, the journal (src/lib/decide).
// GET  /api/decide?ws=<id> → { jev, settings, reactions, decisions, metrics, proposals } (any member)
// GET  /api/decide?ws=<id>&view=jev → { overview, goals, activity }                   (any member)
// GET  /api/decide?ws=<id>&view=goals → { goals }                                     (any member)
// GET  /api/decide?ws=<id>&view=pickers → { databases, projects, calendars, mail }    (editors)
// POST /api/decide?ws=<id> { op, … }:
//   save { reaction } · delete { id }                                                  (editors)
//   resolve { id, accept }  — confirm or dismiss a suggestion                          (editors)
//   settle { id, action: accept|dismiss|undo } — an item of the journal               (editors)
//   metric { key, value, label? } — a live number typed in by hand                     (editors)
//   source { source } — a live number from a database, a project, a calendar or one's mail (editors)
//   goal { issue, key | source, cmp, target, docs? } — the issue closes at the target  (editors)
//   chartGoal { db, view, bar?, cmp, target, title } — a goal on a Documents chart     (editors)
//   findGoal { issue } — Jev links the issue to the number that measures it           (editors)
//   hub { parents?, goals?, design?, calendar? } — what Jev's exact rules do by themselves (owner)
//   jev { on } — may the chosen fields go to Jev (TypeSafe AI, USA)? On by default.    (owner)
//   token — a new secret for /api/pulse/ingest (shown once) · untoken                  (owner)

export async function GET(req: Request) {
  const rl = rateLimited(req, "decide", 120);
  if (rl) return rl;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws");
  if (!access(me.user.id, ws, "read")) return fail(403, "forbidden");
  const id = ws as string;
  const view = new URL(req.url).searchParams.get("view");
  if (view === "jev") {
    const activity = activityOf(id, me.user.id, 60);
    const since = Date.now() - 7 * 86_400_000;
    return json({
      overview: hubOverview(id),
      goals: goalsOf(id, me.user.id),
      activity,
      pending: activity.filter((a) => a.canResolve).length,
      // Done by itself in the last 7 days (what this person may see).
      week: activity.filter((a) => (a.status === "applied" || a.status === "accepted") && a.at > since).length,
    });
  }
  if (view === "goals") return json({ goals: goalsOf(id, me.user.id) });
  if (view === "pickers") {
    if (!access(me.user.id, ws, "edit")) return fail(403, "forbidden");
    let projects: { id: string; name: string }[] = [];
    try {
      projects = listProjects(ctxFor(me.user.id, id, "read")).map((p) => ({ id: p.id, name: p.name }));
    } catch {
      projects = [];
    }
    // Calendars this person reads, and their own Mail views (mail is theirs alone).
    const calendars = readableCalendars(new CalAccess(me.user.id, id)).map((c) => ({ id: c.id, name: c.name }));
    const mail = accountsOf(me.user.id).length ? [...MAIL_SYSTEM_VIEWS.map((v) => ({ id: v, name: "", system: true })), ...mailViewsOf(me.user.id).map((v) => ({ id: v.id, name: v.name, system: false }))] : [];
    return json({ databases: databasesFor(id, me.user.id), projects, calendars, mail });
  }
  const metrics = visibleMetrics(id, me.user.id, metricsOf(id)).map((m) => ({ ...m, source: sourceOf(id, m.key)?.source ?? null }));
  return json({
    jev: { ...jevStats(), configured: jevConfigured() },
    settings: settingsOf(id),
    ...visibleRules(id, me.user.id, reactionsOf(id), decisionsOf(id, 50)),
    metrics,
    // Goals Jev proposes (the issue's Goal panel shows them with Accept / Dismiss).
    proposals: activityOf(id, me.user.id, 100).filter((a) => a.kind === "goal_linked" && a.canResolve),
  });
}

const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/\s/g, "").replace(",", ".")) : NaN);
const opOf = (v: unknown): GoalOp | null => GOAL_OPS.find((o) => o === v) ?? null;
const ISSUE_RE = /^[A-Za-z0-9_-]{6,64}$/;
/** Mail's own views a goal may count (custom views come from the person's settings). */
const MAIL_SYSTEM_VIEWS = ["inbox", "starred", "snoozed"] as const;

export async function POST(req: Request) {
  const rl = rateLimited(req, "decide", 120);
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws");
  const parsed = await readJsonCapped(req, 64_000);
  if (!parsed.ok) return fail(parsed.status, "bad request");
  const body = (parsed.value ?? {}) as Record<string, unknown>;
  const op = body.op;
  const owner = op === "jev" || op === "token" || op === "untoken" || op === "hub";
  if (!access(me.user.id, ws, owner ? "manage" : "edit")) return fail(403, "forbidden");
  const id = ws as string;
  const by = me.user.id;
  switch (op) {
    case "save": {
      const r = saveReaction(id, body.reaction, by);
      return "error" in r ? fail(r.error === "limit" ? 409 : r.error === "forbidden" ? 403 : 400, r.error) : json({ reaction: r });
    }
    case "delete":
      return typeof body.id === "string" && ID_RE.test(body.id) && deleteReaction(id, body.id) ? json({ ok: true }) : fail(404, "not found");
    case "resolve": {
      if (typeof body.id !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(body.id)) return fail(400, "bad request");
      const out = resolve(id, body.id, body.accept === true, by);
      return out === "gone" ? fail(404, "not found") : out === "forbidden" ? fail(403, "forbidden") : json({ result: out });
    }
    case "settle": {
      const action = body.action === "accept" || body.action === "dismiss" || body.action === "undo" ? body.action : null;
      if (typeof body.id !== "string" || !/^[ds]:[A-Za-z0-9_-]{6,40}$/.test(body.id) || !action) return fail(400, "bad request");
      const out = settle(id, body.id, action, by);
      return out === "gone" ? fail(404, "not found") : out === "forbidden" ? fail(403, "forbidden") : json({ result: out });
    }
    case "source": {
      const out = saveSource(id, body.source, by);
      return "error" in out ? fail(out.error === "forbidden" ? 403 : out.error === "limit" ? 409 : 400, out.error) : json(out);
    }
    case "goal": {
      const o = opOf(body.cmp);
      const target = num(body.target);
      if (typeof body.issue !== "string" || !ISSUE_RE.test(body.issue) || !o || !Number.isFinite(target)) return fail(400, "bad request");
      let key = typeof body.key === "string" ? body.key : "";
      if (body.source !== undefined) {
        const src = saveSource(id, body.source, by);
        if ("error" in src) return fail(src.error === "forbidden" ? 403 : src.error === "limit" ? 409 : 400, src.error);
        key = src.key;
      }
      const r = setGoal(id, { issue: body.issue, key, op: o, target, docs: body.docs !== false }, by);
      return "error" in r ? fail(r.error === "forbidden" ? 403 : r.error === "limit" ? 409 : 400, r.error) : json({ reaction: r });
    }
    case "chartGoal": {
      const o = opOf(body.cmp);
      const target = num(body.target);
      const bar = body.bar as { prop?: unknown; key?: unknown } | undefined;
      if (typeof body.db !== "string" || typeof body.view !== "string" || typeof body.title !== "string" || !o || !Number.isFinite(target)) return fail(400, "bad request");
      const r = chartGoal(
        id,
        {
          db: body.db,
          view: body.view,
          op: o,
          target,
          title: body.title,
          locale: typeof body.locale === "string" ? body.locale.slice(0, 10) : "en",
          ...(bar && typeof bar.prop === "string" && typeof bar.key === "string" ? { bar: { prop: bar.prop, key: bar.key } } : {}),
        },
        by
      );
      return "error" in r ? fail(r.error === "forbidden" ? 403 : r.error === "limit" ? 409 : 400, r.error) : json(r);
    }
    case "findGoal": {
      if (typeof body.issue !== "string" || !ISSUE_RE.test(body.issue)) return fail(400, "bad request");
      const out = await proposeGoal(id, body.issue, by);
      return out.status === "none" && out.why === "forbidden" ? fail(403, "forbidden") : json(out);
    }
    case "hub":
      audit(by, "decide.hub", id);
      return json({ rules: setHubSettings(id, body, by) });
    case "metric": {
      const value = typeof body.value === "number" ? body.value : Number(body.value);
      const label = typeof body.label === "string" ? body.label.slice(0, 120) : null;
      return typeof body.key === "string" && putMetric(id, body.key, value, label, by) ? json({ ok: true }) : fail(400, "bad request");
    }
    case "jev":
      setJev(id, body.on === true, by);
      audit(by, body.on === true ? "decide.jev.on" : "decide.jev.off", id);
      return json({ settings: settingsOf(id) });
    case "token": {
      const token = newIngestToken(id, by);
      audit(by, "decide.ingest.token", id);
      return json({ token });
    }
    case "untoken":
      revokeIngestToken(id);
      audit(by, "decide.ingest.revoke", id);
      return json({ settings: settingsOf(id) });
    default:
      return fail(400, "bad request");
  }
}
