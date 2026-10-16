import { currentUser, fail, json } from "@/lib/http";
import { GeoBusy, reversePlace } from "@/lib/maps";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// GET /api/maps/reverse?lat=&lng=&lang=ru|en → { place } — the name and
// address of a point (a dragged pin, "Use current location"). Signed-in only.
export async function GET(req: Request) {
  const rl = rateLimited(req, "maps-geo");
  if (rl) return rl;
  if (!currentUser(req)) return fail(401, "sign in required");
  const u = new URL(req.url);
  const lat = Number(u.searchParams.get("lat"));
  const lng = Number(u.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return fail(400, "bad point");
  try {
    return json({ place: await reversePlace(lat, lng, u.searchParams.get("lang") ?? "en") });
  } catch (e) {
    return fail(e instanceof GeoBusy ? 503 : 502, "geocoder unavailable");
  }
}
