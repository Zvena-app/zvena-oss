import { health } from "@/lib/health";

export const dynamic = "force-dynamic";

// GET /api/health → { ok, status, at, parts } (200 when ready, 503 otherwise) —
// for the container's healthcheck, deploy/scripts (wait_healthy, monitor.sh)
// and load balancers. `ok` is readiness; `status` is what /status shows
// (src/lib/health.ts).
export async function GET() {
  const h = await health();
  return Response.json(h, { status: h.ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
