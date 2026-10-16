import { cookieSecure } from "@/lib/auth";
import { config } from "@/lib/config";
import { currentUser, guestId, json } from "@/lib/http";
import { rateLimited } from "@/lib/rate-limit";
import { touchGuest } from "@/lib/storage";

export const dynamic = "force-dynamic";

// GET /api/guest → { files, removeAt, ttlDays } — a guest's visit keeps their
// uploads alive; the app shows when they would be removed (the warning before
// the cleanup job deletes abandoned guest files).
export async function GET(req: Request) {
  const rl = rateLimited(req, "notes-sync");
  if (rl) return rl;
  if (currentUser(req)) return json({ files: 0, removeAt: null, ttlDays: config.guestFileTtlDays });
  const g = guestId(req);
  if (!g) return json({ files: 0, removeAt: null, ttlDays: config.guestFileTtlDays });
  const t = touchGuest(g);
  return json({ ...t, ttlDays: config.guestFileTtlDays }, 200, { "set-cookie": `zv_g=${g}; Path=/; HttpOnly; SameSite=Lax${cookieSecure() ? "; Secure" : ""}; Max-Age=${400 * 86400}` });
}
