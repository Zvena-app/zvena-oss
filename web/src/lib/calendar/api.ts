// HTTP layer of zvena Calendar: one router behind /api/calendar/*.
//
// Member routes pass one gate: a per-IP rate limit, the CSRF origin check for
// writes, the session, and membership of the workspace named by ?ws= (each
// operation then checks the calendar's level, lib/calendar/access.ts).
// Public routes — the booking page, the secret feed, e-mail invitations —
// carry their own proof (a slug that is on, a token whose HMAC is stored)
// and tighter limits. Domain errors (CalError) become JSON with their status;
// anything else is a 500 that logs its kind only (never request data).

import { readCookie } from "../auth";
import { issueFromEvent } from "../eco/calendar";
import { EcoError } from "../eco/actions";
import { projectOptions } from "../eco/lists";
import { crossSite, currentUser, fail, json, NO_STORE } from "../http";
import { parseAcceptLanguage, resolveLocale, UI_LANG_COOKIE } from "../i18n";
import { lettersLeave } from "../mail";
import { originOf, emit } from "../pulse/bus";
import { rateLimited } from "../rate-limit";
import { readBodyCapped, readJsonCapped } from "../safe-json";
import { sql } from "../store";
import { can } from "../workspaces";
import type { Locale } from "@/i18n/locales";
import { CalAccess, calRow, canSeeEvent } from "./access";
import { book, bookingByToken, cancelBooking, deleteLink, listLinks, publicLink, rescheduleBooking, saveLink, slotsOf } from "./booking";
import { accountsOf, connectAccount, linkRemote, remoteCalendars, removeAccount } from "./caldav";
import { calendarInfo, calendarOfFeed, createCalendar, deleteCalendar, ensureDefault, feedOf, listCalendars, membersOf, prefsOf, prefsSaved, rememberLocale, resetFeed, revokeFeed, savePrefs, setShare, updateCalendar } from "./calendars";
import { attachDoc, createMeetingNotes, detachDoc } from "./docs";
import { afterWrite, whenLine } from "./effects";
import { CalError, createEvent, deleteEvent, duplicateEvent, eventDetail, eventRow, listRange, readableCalendars, rsvp, undo, updateEvent, type WriteOutcome } from "./events";
import { calendarIcs } from "./export";
import { addLayer, layerItems, listDatabases, listLayers, moveDocRow, removeLayer, updateLayer } from "./layers";
import { PROVIDERS, syncNow } from "./providers";
import { tokenHash } from "./seal";
import { importFile, refreshStale, subscribe } from "./subscriptions";
import { addDays, dayOf, validTimeZone } from "./tz";
import { RSVPS, type Bootstrap, type Rsvp } from "./types";

type Body = Record<string, unknown>;
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

interface Call {
  req: Request;
  url: URL;
  acc: CalAccess;
  me: { id: string; name: string; email?: string };
  p: Record<string, string>;
  body: Body;
  locale: Locale;
  origin?: string;
}

type Handler = (c: Call) => unknown | Promise<unknown>;

interface Route {
  method: Method;
  path: string[];
  run: Handler;
  scope?: string;
  limit?: number;
  /** Raw body (an .ics file): the JSON body is not read. */
  raw?: boolean;
}

const routes: Route[] = [];
function on(method: Method, path: string, run: Handler, opts: { scope?: string; limit?: number; raw?: boolean } = {}): void {
  routes.push({ method, path: path.split("/").filter(Boolean), run, ...opts });
}

const q = (c: Call, k: string) => c.url.searchParams.get(k);
const num = (c: Call, k: string) => {
  const v = Number(q(c, k));
  if (!Number.isFinite(v)) throw new CalError(400, `bad ${k}`);
  return v;
};
const tzOf = (c: Call) => {
  const t = q(c, "tz");
  return validTimeZone(t) ? t : prefsOf(c.me.id).tz;
};

/** A write's effects (index, pulse, guests), then its answer. */
function written(c: Call, out: WriteOutcome, notifyGuests = true): { event: ReturnType<typeof eventDetail>; undo: string } {
  afterWrite({ ws: c.acc.ws, by: c.me.id, origin: c.origin, seriesIds: out.seriesIds, calIds: out.calIds, guests: out.guests, moved: out.moved, deleted: out.deleted, notifyGuests, locale: c.locale });
  return { event: out.deleted.includes(out.id) ? null : eventDetail(c.acc, out.id, out.occ), undo: out.undo };
}

function poke(c: Call, calId: string): void {
  emit(c.acc.ws, { type: "calendar", ref: calId, by: c.me.id, origin: c.origin });
}

// --- Bootstrap -------------------------------------------------------------------

on("GET", "bootstrap", (c): Bootstrap => {
  rememberLocale(c.me.id, c.locale);
  const prefs = prefsOf(c.me.id);
  ensureDefault(c.acc, c.me.name, validTimeZone(q(c, "tz")) ? (q(c, "tz") as string) : prefs.tz);
  refreshStale(readableCalendars(c.acc));
  const role = c.acc.role;
  return {
    me: { id: c.me.id, name: c.me.name, ...(c.me.email ? { email: c.me.email } : {}) },
    ws: { id: c.acc.ws, name: (sql("SELECT name FROM workspaces WHERE id = ?").get(c.acc.ws) as { name: string } | undefined)?.name ?? "", canEdit: Boolean(role && can.edit(role)) },
    prefs,
    prefsSaved: prefsSaved(c.me.id),
    calendars: listCalendars(c.acc),
    layers: listLayers(c.acc, c.locale),
    links: listLinks(c.acc),
    members: membersOf(c.acc),
    providers: PROVIDERS.map((p) => ({ id: p.id, available: p.available(), writable: p.writable })),
    mailOn: lettersLeave(),
  };
});
on("PUT", "prefs", (c) => ({ prefs: savePrefs(c.me.id, c.body) }));

// --- Events ------------------------------------------------------------------------

on("GET", "events", async (c) => {
  const from = num(c, "from");
  const to = num(c, "to");
  if (to <= from) throw new CalError(400, "bad range");
  const tz = tzOf(c);
  const items = listRange({ acc: c.acc, tz }, { from, to });
  const layers = q(c, "layers") === "0" ? [] : await layerItems(c.acc, c.locale, addDays(dayOf(from, tz), -1), addDays(dayOf(to, tz), 1));
  return { items, layers };
});

/** Teammates' busy times ("Meet with"): only calendars shared with the viewer at least as free/busy. */
on("GET", "freebusy", (c) => {
  const from = num(c, "from");
  const to = num(c, "to");
  const users = (q(c, "users") ?? "").split(",").filter((u) => /^[A-Za-z0-9_-]{6,64}$/.test(u)).slice(0, 8);
  const out: { id: string; name: string; busy: { start: number; end: number; allDay: boolean; startDay: string; endDay: string; title?: string }[] }[] = [];
  for (const u of users) {
    const name = (sql("SELECT u.name FROM users u JOIN members m ON m.user_id = u.id AND m.ws_id = ? WHERE u.id = ?").get(c.acc.ws, u) as { name: string } | undefined)?.name;
    if (!name) continue;
    const theirs = sql("SELECT * FROM cal_calendars WHERE ws_id = ? AND owner_id = ? AND deleted_at IS NULL").all(c.acc.ws, u) as unknown as NonNullable<ReturnType<typeof calRow>>[];
    const visible = theirs.filter((cal) => c.acc.level(cal) !== null);
    if (!visible.length) {
      out.push({ id: u, name, busy: [] });
      continue;
    }
    const readable = new Set(visible.filter((cal) => c.acc.canRead(cal)).map((cal) => cal.id));
    const items = listRange({ acc: new CalAccess(u, c.acc.ws), tz: tzOf(c) }, { from, to, calIds: visible.map((v) => v.id) });
    out.push({ id: u, name, busy: items.filter((e) => e.busy).map((e) => ({ start: e.start, end: e.end, allDay: e.allDay, startDay: e.startDay, endDay: e.endDay, ...(readable.has(e.calId) ? { title: e.title } : {}) })) });
  }
  return { users: out };
});

on("GET", "events/:id", (c) => {
  const d = eventDetail(c.acc, c.p.id, q(c, "occ"));
  if (!d) throw new CalError(404, "event not found");
  return { event: d };
});
on("POST", "events", (c) => written(c, createEvent(c.acc, c.body), c.body.notify !== false));
on("PATCH", "events/:id", (c) => written(c, updateEvent(c.acc, c.p.id, c.body), c.body.notify !== false));
on("DELETE", "events/:id", (c) => written(c, deleteEvent(c.acc, c.p.id, { scope: q(c, "scope"), occ: q(c, "occ") }), q(c, "notify") !== "0"));
on("POST", "events/:id/duplicate", (c) => written(c, duplicateEvent(c.acc, c.p.id, c.body.occ), false));
on("POST", "events/:id/rsvp", (c) => {
  const series = rsvp(c.acc, c.p.id, c.body.rsvp);
  const r = eventRow(series);
  if (r) poke(c, r.cal_id);
  return { event: eventDetail(c.acc, c.p.id, typeof c.body.occ === "string" ? c.body.occ : null) };
});
on("POST", "undo", (c) => {
  const res = undo(c.acc, c.body.token);
  if (!res) throw new CalError(410, "nothing to undo");
  afterWrite({ ws: c.acc.ws, by: c.me.id, origin: c.origin, seriesIds: res.seriesIds, calIds: res.calIds, notifyGuests: false });
  return { ok: true };
});
on("POST", "events/:id/notes", async (c) => {
  const res = await createMeetingNotes(c.acc, c.me, c.p.id, c.body.occ, c.locale);
  return { ...res, event: eventDetail(c.acc, c.p.id, typeof c.body.occ === "string" ? c.body.occ : null) };
});
on("POST", "events/:id/docs", (c) => {
  attachDoc(c.acc, c.p.id, c.body.noteId);
  return { event: eventDetail(c.acc, c.p.id, typeof c.body.occ === "string" ? c.body.occ : null) };
});
on("DELETE", "events/:id/docs/:note", (c) => {
  detachDoc(c.acc, c.p.id, c.p.note);
  return { event: eventDetail(c.acc, c.p.id, q(c, "occ")) };
});
on("POST", "events/:id/issue", async (c) => {
  const ev = eventRow(c.p.id);
  if (!ev || !canSeeEvent(c.acc, ev)) throw new CalError(404, "event not found");
  return { card: await issueFromEvent({ userId: c.me.id, name: c.me.name, wsId: c.acc.ws, locale: c.locale, origin: c.origin }, { event: ev.parent_id ?? ev.id, occ: c.body.occ, title: c.body.title, teamId: c.body.teamId, projectId: c.body.projectId }) };
});

/** Events whose title, place or description match (the calendar's own search box). */
on("GET", "search", (c) => {
  const text = (q(c, "q") ?? "").trim().slice(0, 100);
  if (!text) return { items: [] };
  const cals = readableCalendars(c.acc).map((x) => x.id);
  const like = `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const invited = (sql("SELECT a.event_id FROM cal_attendees a JOIN cal_events e ON e.id = a.event_id WHERE a.user_id = ? AND e.ws_id = ?").all(c.me.id, c.acc.ws) as { event_id: string }[]).map((r) => r.event_id);
  const rows = sql(
    `SELECT id FROM cal_events WHERE deleted_at IS NULL AND parent_id IS NULL AND (cal_id IN (SELECT value FROM json_each(?)) OR id IN (SELECT value FROM json_each(?)))
       AND (title LIKE ? ESCAPE '\\' OR location LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
     ORDER BY ABS(start_at - ?) LIMIT 50`
  ).all(JSON.stringify(cals), JSON.stringify(invited), like, like, like, Date.now()) as { id: string }[];
  return { items: rows.map((r) => eventDetail(c.acc, r.id)).filter(Boolean) };
});

// --- Calendars ---------------------------------------------------------------------

on("POST", "calendars", (c) => {
  const cal = createCalendar(c.acc, c.body);
  poke(c, cal.id);
  return { calendar: calendarInfo(c.acc, cal) };
});
on("PATCH", "calendars/:id", (c) => {
  const cal = updateCalendar(c.acc, c.p.id, c.body);
  poke(c, cal.id);
  return { calendar: listCalendars(c.acc).find((x) => x.id === cal.id) ?? null };
});
on("DELETE", "calendars/:id", (c) => {
  const cal = deleteCalendar(c.acc, c.p.id);
  poke(c, cal.id);
  return { ok: true };
});
on("PUT", "calendars/:id/shares/:user", (c) => {
  setShare(c.acc, c.p.id, c.p.user, c.body.level ?? null);
  poke(c, c.p.id);
  return { calendar: listCalendars(c.acc).find((x) => x.id === c.p.id) ?? null };
});
on("DELETE", "calendars/:id/shares/:user", (c) => {
  setShare(c.acc, c.p.id, c.p.user, null);
  poke(c, c.p.id);
  return { calendar: listCalendars(c.acc).find((x) => x.id === c.p.id) ?? null };
});
on("GET", "calendars/:id/feed", (c) => ({ url: feedOf(c.acc, c.p.id) }));
on("POST", "calendars/:id/feed", (c) => ({ url: resetFeed(c.acc, c.p.id) }));
on("DELETE", "calendars/:id/feed", (c) => {
  revokeFeed(c.acc, c.p.id);
  return { url: null };
});
on("POST", "calendars/:id/sync", async (c) => {
  const cal = calRow(c.p.id);
  if (!cal || c.acc.level(cal) !== "owner") throw new CalError(404, "calendar not found");
  const res = await syncNow(cal.id);
  return { ok: res.ok, error: res.error ?? null, calendar: listCalendars(c.acc).find((x) => x.id === cal.id) ?? null };
}, { scope: "calendar-sync", limit: 20 });
on("POST", "calendars/:id/import", async (c) => {
  const raw = await readBodyCapped(c.req, 5_000_000);
  if (!raw.ok) throw new CalError(raw.status, raw.status === 413 ? "file too large" : "bad request");
  const res = importFile(c.acc, c.p.id, new TextDecoder().decode(raw.bytes));
  return { added: res.added, updated: res.updated };
}, { raw: true, scope: "calendar-import", limit: 10 });
on("POST", "subscriptions", async (c) => ({ calendar: await subscribe(c.acc, c.body) }), { scope: "calendar-subscribe", limit: 10 });

// --- CalDAV ------------------------------------------------------------------------

on("GET", "caldav/accounts", (c) => ({ accounts: accountsOf(c.acc) }));
on("POST", "caldav/accounts", async (c) => connectAccount(c.acc, c.body), { scope: "calendar-caldav", limit: 10 });
on("GET", "caldav/accounts/:id/calendars", async (c) => ({ calendars: await remoteCalendars(c.acc, c.p.id) }), { scope: "calendar-caldav", limit: 20 });
on("POST", "caldav/accounts/:id/link", async (c) => ({ calendar: await linkRemote(c.acc, c.p.id, c.body) }), { scope: "calendar-caldav", limit: 20 });
on("DELETE", "caldav/accounts/:id", (c) => {
  for (const cal of removeAccount(c.acc, c.p.id)) poke(c, cal);
  return { ok: true };
});

// --- Docs & Projects layers -------------------------------------------------------------

on("GET", "docs/databases", (c) => ({ databases: listDatabases(c.acc) }));
on("GET", "projects/options", (c) => ({ projects: projectOptions({ userId: c.me.id, wsId: c.acc.ws, locale: c.locale }) }));
on("POST", "layers", (c) => {
  addLayer(c.acc, c.body);
  return { layers: listLayers(c.acc, c.locale) };
});
on("PATCH", "layers/:kind/:ref", (c) => {
  updateLayer(c.acc, c.p.kind, c.p.ref, c.body);
  return { layers: listLayers(c.acc, c.locale) };
});
on("DELETE", "layers/:kind/:ref", (c) => {
  removeLayer(c.acc, c.p.kind, c.p.ref);
  return { layers: listLayers(c.acc, c.locale) };
});
on("PATCH", "docs/rows/:row", async (c) => ({ value: await moveDocRow(c.me, c.acc.ws, { ...c.body, rowId: c.p.row }) }));

// --- Scheduling links -------------------------------------------------------------------

on("GET", "links", (c) => ({ links: listLinks(c.acc) }));
on("POST", "links", (c) => ({ link: saveLink(c.acc, null, c.body, c.me.name) }));
on("PATCH", "links/:id", (c) => ({ link: saveLink(c.acc, c.p.id, c.body, c.me.name) }));
on("DELETE", "links/:id", (c) => {
  deleteLink(c.acc, c.p.id);
  return { ok: true };
});

// ------------------------------------------------------------ dispatch

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

export function requestLocale(req: Request): Locale {
  return resolveLocale(readCookie(req, UI_LANG_COOKIE), parseAcceptLanguage(req.headers.get("accept-language")));
}

function errorOf(e: unknown, where: string): Response {
  if (e instanceof CalError) return json({ error: e.code }, e.status);
  if (e instanceof EcoError) return json({ error: e.code }, e.status);
  if (e instanceof SyntaxError) return fail(400, "bad request");
  console.error(`[calendar] ${where} failed (${e instanceof Error ? e.name : "error"})`);
  return fail(500, "internal error");
}

export async function handle(req: Request, method: Method, segs: string[]): Promise<Response> {
  const pub = await handlePublic(req, method, segs);
  if (pub) return pub;
  const m = match(method, segs);
  if (!m) return fail(404, "not found");
  const rl = rateLimited(req, m.route.scope ?? "calendar", m.route.limit ?? 900);
  if (rl) return rl;
  if (method !== "GET") {
    const badOrigin = crossSite(req);
    if (badOrigin) return badOrigin;
  }
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const url = new URL(req.url);
  const ws = url.searchParams.get("ws");
  if (!ws || !/^[A-Za-z0-9_-]{8,40}$/.test(ws)) return fail(403, "forbidden");
  const acc = new CalAccess(me.user.id, ws);
  if (!acc.member) return fail(403, "forbidden");
  try {
    let body: Body = {};
    if (!m.route.raw && method !== "GET" && method !== "DELETE") {
      const parsed = await readJsonCapped(req, 1_000_000);
      if (!parsed.ok) return fail(parsed.status, parsed.status === 413 ? "request too large" : "bad request");
      if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return fail(400, "bad request");
      body = parsed.value as Body;
    }
    const out = await m.route.run({ req, url, acc, me: { id: me.user.id, name: me.user.name, ...(me.user.email ? { email: me.user.email } : {}) }, p: m.p, body, locale: requestLocale(req), origin: originOf(req) });
    return json(out ?? { ok: true });
  } catch (e) {
    return errorOf(e, `${method} ${m.route.path.join("/")}`);
  }
}

// ------------------------------------------------------------ public routes

const SLUG = /^[a-z0-9-]{3,48}$/;
const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;

async function body(req: Request): Promise<Body | null> {
  const parsed = await readJsonCapped(req, 20_000);
  return parsed.ok && parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value) ? (parsed.value as Body) : null;
}

/** The routes that need no session (null: not one of them). */
async function handlePublic(req: Request, method: Method, segs: string[]): Promise<Response | null> {
  const [a, b, c2, d] = segs;
  try {
    // The secret feed: GET feed/<token>.ics
    if (a === "feed" && segs.length === 2 && method === "GET") {
      const rl = rateLimited(req, "calendar-feed", 60);
      if (rl) return rl;
      const cal = calendarOfFeed((b ?? "").replace(/\.ics$/, ""));
      if (!cal) return fail(404, "not found");
      return new Response(calendarIcs(cal), { headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "private, max-age=300", "x-robots-tag": "noindex", "content-disposition": `inline; filename="calendar.ics"` } });
    }
    // A calendar as a download (signed in, may read it): GET calendars/<id>/ics?ws=
    if (a === "calendars" && segs.length === 3 && c2 === "ics" && method === "GET") {
      const rl = rateLimited(req, "calendar-export", 20);
      if (rl) return rl;
      const me = currentUser(req);
      if (!me) return fail(401, "unauthorized");
      const ws = new URL(req.url).searchParams.get("ws");
      const acc = new CalAccess(me.user.id, ws ?? "");
      const cal = calRow(b);
      if (!acc.member || !cal || !acc.canRead(cal)) return fail(404, "not found");
      const name = cal.name.replace(/[^\w .-]+/g, "").trim().slice(0, 60) || "calendar";
      return new Response(calendarIcs(cal), { headers: { ...NO_STORE, "content-type": "text/calendar; charset=utf-8", "content-disposition": `attachment; filename="${name}.ics"` } });
    }
    // The booking page's API: public/<slug>/slots, public/<slug>/book, public/<slug>/booking/<token>[/cancel|/reschedule]
    if (a === "public" && SLUG.test(b ?? "")) {
      if (segs.length === 3 && c2 === "slots" && method === "GET") {
        const rl = rateLimited(req, "calendar-slots", 60);
        if (rl) return rl;
        const link = publicLink(b);
        if (!link) return fail(404, "not found");
        const url = new URL(req.url);
        const from = Number(url.searchParams.get("from"));
        const to = Number(url.searchParams.get("to"));
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return fail(400, "bad range");
        const except = url.searchParams.get("t");
        const managed = except ? bookingByToken(b, except) : null;
        return json({ slots: slotsOf(link.row, from, to, Date.now(), managed ? { event: managed.booking.event_id, booking: managed.booking.id } : undefined) });
      }
      if (segs.length === 3 && c2 === "book" && method === "POST") {
        const bad = crossSite(req);
        if (bad) return bad;
        const rl = rateLimited(req, "calendar-book", 5);
        if (rl) return rl;
        const input = await body(req);
        if (!input) return fail(400, "bad request");
        // A field people never see: filled in, it was a bot.
        if (typeof input.website === "string" && input.website) return fail(400, "bad request");
        const res = await book(b, input);
        // `mailed: false`: no letter will come (no mail service here) — the page keeps the private link in view.
        return json({ ok: true, start: res.start, end: res.end, manage: res.manage, mailed: lettersLeave() });
      }
      if (segs.length >= 4 && c2 === "booking" && TOKEN.test(d ?? "")) {
        const rl = rateLimited(req, "calendar-manage", 20);
        if (rl) return rl;
        if (segs.length === 5 && method === "POST") {
          const bad = crossSite(req);
          if (bad) return bad;
          if (segs[4] === "cancel") {
            await cancelBooking(b, d);
            return json({ ok: true });
          }
          if (segs[4] === "reschedule") {
            const input = await body(req);
            const res = await rescheduleBooking(b, d, input?.start);
            return json({ ok: true, ...res });
          }
        }
        return fail(404, "not found");
      }
      return fail(404, "not found");
    }
    // An invitation by e-mail: GET invite/<token> (what it is), POST invite/<token> { rsvp }
    if (a === "invite" && segs.length === 2 && TOKEN.test(b ?? "")) {
      const rl = rateLimited(req, "calendar-invite", 30);
      if (rl) return rl;
      const att = sql("SELECT event_id, email, rsvp FROM cal_attendees WHERE token_hash = ?").get(tokenHash("cal-rsvp", b as string)) as { event_id: string; email: string; rsvp: Rsvp } | undefined;
      const ev = att ? eventRow(att.event_id) : null;
      if (!att || !ev || ev.deleted_at) return fail(404, "not found");
      if (method === "POST") {
        const bad = crossSite(req);
        if (bad) return bad;
        const input = await body(req);
        const answer = input?.rsvp;
        if (!RSVPS.includes(answer as Rsvp) || answer === "needs-action") return fail(400, "bad answer");
        sql("UPDATE cal_attendees SET rsvp = ?, responded_at = ? WHERE event_id = ? AND email = ?").run(answer as string, Date.now(), att.event_id, att.email);
        emit(ev.ws_id, { type: "calendar", ref: ev.cal_id, refs: [ev.id] });
        return json({ ok: true, rsvp: answer });
      }
      if (method === "GET") {
        const locale = requestLocale(req);
        return json({ title: ev.title, when: whenLine(ev, locale, ev.tz), location: ev.location, rsvp: att.rsvp });
      }
      return fail(405, "method not allowed");
    }
  } catch (e) {
    return errorOf(e, `public ${a ?? ""}`);
  }
  return null;
}
