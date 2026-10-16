import { cookieSecure } from "@/lib/auth";
import { config } from "@/lib/config";
import { currentUser, guestId, json } from "@/lib/http";
import { rateLimited } from "@/lib/rate-limit";
import { touchGuest } from "@/lib/storage";

export const dynamic = "force-dynamic";

// GET /api/guest → { files, removeAt, ttlDays, uploadMb } — a guest's visit
// keeps their id alive; the app shows when their uploads will be removed
// (each one ttlDays after upload, by the daily cleanup job) and how much a
// guest may upload.
export async function GET(req: Request) {
  const rl = rateLimited(req, "notes-sync");
  if (rl) return rl;
  const limits = { ttlDays: config.guestFileTtlDays, uploadMb: config.guestUploadMb };
  if (currentUser(req)) return json({ files: 0, removeAt: null, ...limits });
  const g = guestId(req);
  if (!g) return json({ files: 0, removeAt: null, ...limits });
  const t = touchGuest(g);
  return json({ ...t, ...limits }, 200, { "set-cookie": `zv_g=${g}; Path=/; HttpOnly; SameSite=Lax${cookieSecure() ? "; Secure" : ""}; Max-Age=${400 * 86400}` });
}
