import { getUser } from "@/lib/notes/api/handlers";
import { apiRoute, preflight } from "@/lib/notes/api/respond";

export const dynamic = "force-dynamic";

// GET /api/v1/users/{id} — one person or bot of the workspace.
export const GET = apiRoute<{ id: string }>("users", (ctx, p) => getUser(ctx, p.id));
export const OPTIONS = preflight;
