import { health } from "@/lib/health";

export const dynamic = "force-dynamic";

// GET /api/health → { ok, at, parts } (200 when healthy, 503 otherwise) —
// for the uptime monitor (deploy/monitor) and load balancers.
export async function GET() {
  const h = await health();
  return Response.json(h, { status: h.ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
