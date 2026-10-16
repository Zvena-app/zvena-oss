import { me } from "@/lib/notes/api/handlers";
import { apiRoute, preflight } from "@/lib/notes/api/respond";

export const dynamic = "force-dynamic";

// GET /api/v1/users/me — the integration's bot user.
export const GET = apiRoute(null, (ctx) => me(ctx));
export const OPTIONS = preflight;
