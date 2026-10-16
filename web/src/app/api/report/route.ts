import { config } from "@/lib/config";
import { crossSite, currentUser, fail, json } from "@/lib/http";
import { rateLimited } from "@/lib/rate-limit";
import { createReport, parseTarget, REASONS, type Reason } from "@/lib/reports";
import { readJsonCapped } from "@/lib/safe-json";
import { sendAdminMail } from "@/lib/mail";

export const dynamic = "force-dynamic";

// POST /api/report { url, reason, details?, contact? } — a report about
// public content. Open to everyone (signed in or not), rate limited.
export async function POST(req: Request) {
  const rl = rateLimited(req, "report");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const p = await readJsonCapped(req, 20_000);
  if (!p.ok) return fail(400, "bad request");
  const b = p.value as { url?: unknown; reason?: unknown; details?: unknown; contact?: unknown };
  const t = typeof b.url === "string" ? parseTarget(b.url) : null;
  if (!t) return fail(400, "unknown link");
  if (!(REASONS as readonly unknown[]).includes(b.reason)) return fail(400, "bad reason");
  const id = createReport({
    kind: t.kind,
    target: t.target,
    reason: b.reason as Reason,
    details: typeof b.details === "string" ? b.details : "",
    contact: typeof b.contact === "string" ? b.contact : "",
    reporterId: currentUser(req)?.user.id ?? null,
  });
  void sendAdminMail("New report on zvena", `Reason: ${String(b.reason)}\nQueue: ${config.appUrl}/admin\nReport id: ${id}`).catch(() => undefined);
  return json({ ok: true });
}
