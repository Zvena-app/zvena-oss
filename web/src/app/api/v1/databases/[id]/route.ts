import { getDatabase, updateDatabase } from "@/lib/notes/api/handlers";
import { apiRoute, preflight } from "@/lib/notes/api/respond";

export const dynamic = "force-dynamic";

// GET   /api/v1/databases/{id} — a database and its property schema.
// PATCH /api/v1/databases/{id} { title, properties, icon, cover, in_trash } — renames, adds, changes or removes properties.
export const GET = apiRoute<{ id: string }>("read", (ctx, p) => getDatabase(ctx, p.id));
export const PATCH = apiRoute<{ id: string }>("update", (ctx, p) => updateDatabase(ctx, p.id));
export const OPTIONS = preflight;
