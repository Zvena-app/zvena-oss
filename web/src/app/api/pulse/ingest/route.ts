import { fail, json } from "@/lib/http";
import { putMetric, wsOfIngestToken } from "@/lib/decide/engine";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";

export const dynamic = "force-dynamic";

// Live numbers from outside (a CRM, 1C, a script, a Board chart's data source).
//
//   POST /api/pulse/ingest
//   Authorization: Bearer zvi_…            (the workspace owner makes it: /api/decide {op:"token"})
//   { "metric": "revenue", "value": 1250000, "label": "Выручка, ₽" }
//   or { "metrics": [{ "metric": …, "value": … }, …] }   (up to 50)
//   → { saved: n }
//
// Each number lands on the workspace's pulse: open dashboards redraw at once
// and reactions ("when revenue ≥ 1 000 000, mark the goal done") judge it.
// No cookies here, so no CSRF; the secret is the only key.

export async function POST(req: Request) {
  const rl = rateLimited(req, "pulse-ingest", 240);
  if (rl) return rl;
  const auth = req.headers.get("authorization") ?? "";
  const ws = wsOfIngestToken(auth.replace(/^Bearer\s+/i, "").trim());
  if (!ws) return fail(401, "unauthorized");
  const parsed = await readJsonCapped(req, 32_000);
  if (!parsed.ok) return fail(parsed.status, "bad request");
  const body = (parsed.value ?? {}) as { metric?: unknown; value?: unknown; label?: unknown; metrics?: unknown };
  const items = (Array.isArray(body.metrics) ? body.metrics : [body]).slice(0, 50) as { metric?: unknown; value?: unknown; label?: unknown }[];
  let saved = 0;
  for (const m of items) {
    const value = typeof m?.value === "number" ? m.value : typeof m?.value === "string" ? Number(m.value.replace(/\s/g, "").replace(",", ".")) : NaN;
    const label = typeof m?.label === "string" ? m.label.slice(0, 120) : null;
    if (typeof m?.metric === "string" && putMetric(ws, m.metric, value, label, "ingest")) saved++;
  }
  return saved ? json({ saved }) : fail(400, "bad request");
}
