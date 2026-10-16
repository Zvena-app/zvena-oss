import { crossSite, currentUser, fail, json } from "@/lib/http";
import { manualTimeZone, setManualTimeZone } from "@/lib/notes/follows";
import { setTimeZone, timeZoneOf, validTimeZone } from "@/lib/notes/reminders-server";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";

export const dynamic = "force-dynamic";

// The signed-in person's time zone, so reminders reach their Inbox at their own 9:00.
// GET                      → { tz, manual }
// POST { tz }              — their browser's (ignored while they chose one in Settings)
// POST { tz, manual }      — Settings (Notion's "Time zone"): manual true keeps it; false goes back to the browser's
export async function GET(req: Request) {
  const rl = rateLimited(req, "ws");
  if (rl) return rl;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  return json({ tz: timeZoneOf(me.user.id), manual: manualTimeZone(me.user.id) });
}

export async function POST(req: Request) {
  const rl = rateLimited(req, "ws");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const p = await readJsonCapped(req, 500);
  const body = p.ok ? (p.value as { tz?: unknown; manual?: unknown }) : {};
  const tz = body.tz;
  if (!validTimeZone(tz)) return fail(400, "bad time zone");
  if (typeof body.manual === "boolean") setManualTimeZone(me.user.id, body.manual);
  else if (manualTimeZone(me.user.id)) return json({ ok: true, kept: true });
  setTimeZone(me.user.id, tz);
  return json({ ok: true });
}
