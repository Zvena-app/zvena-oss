import { currentUser, fail } from "@/lib/http";
import { getTile, parseTile } from "@/lib/maps";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// GET /api/maps/tile/<z>/<x>/<y>.png — a map tile for the Map view and the
// Place picker, through our server (lib/maps.ts): the browser never talks to
// the map provider. Signed-in people only (not an open tile proxy).
const NO_STORE = { "cache-control": "private, no-store" };

export async function GET(req: Request, { params }: { params: Promise<{ z: string; x: string; y: string }> }) {
  const rl = rateLimited(req, "maps-tile");
  if (rl) return rl;
  if (!currentUser(req)) return fail(401, "sign in required");
  const { z, x, y } = await params;
  const t = parseTile(z, x, y);
  if (!t) return new Response("not found", { status: 404, headers: NO_STORE });
  const bytes = await getTile(t);
  if (!bytes) return new Response("unavailable", { status: 502, headers: NO_STORE });
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "image/png",
      "content-length": String(bytes.byteLength),
      "cache-control": "private, max-age=604800",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}
