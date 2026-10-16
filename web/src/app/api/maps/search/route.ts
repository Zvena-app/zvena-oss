import { currentUser, fail, json } from "@/lib/http";
import { GeoBusy, searchPlaces } from "@/lib/maps";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// GET /api/maps/search?q=<address or name>&lang=ru|en → { results: Place[] }
// Address search of the Place property (on Enter, not as you type), through
// our server and its cache (lib/maps.ts). Signed-in people only.
export async function GET(req: Request) {
  const rl = rateLimited(req, "maps-geo");
  if (rl) return rl;
  if (!currentUser(req)) return fail(401, "sign in required");
  const u = new URL(req.url);
  const q = (u.searchParams.get("q") ?? "").trim();
  if (q.length < 2 || q.length > 200) return fail(400, "bad query");
  try {
    const results = await searchPlaces(q, u.searchParams.get("lang") ?? "en");
    return results ? json({ results }) : fail(502, "geocoder unavailable");
  } catch (e) {
    return fail(e instanceof GeoBusy ? 503 : 502, "geocoder unavailable");
  }
}
