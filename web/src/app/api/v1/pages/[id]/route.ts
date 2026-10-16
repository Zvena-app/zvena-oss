import { getPage, updatePage } from "@/lib/notes/api/handlers";
import { apiRoute, preflight } from "@/lib/notes/api/respond";

export const dynamic = "force-dynamic";

// GET   /api/v1/pages/{id} — a page with its properties.
// PATCH /api/v1/pages/{id} { properties, icon, cover, in_trash } — changes it (or moves it to / out of the trash).
export const GET = apiRoute<{ id: string }>("read", (ctx, p) => getPage(ctx, p.id));
export const PATCH = apiRoute<{ id: string }>("update", (ctx, p) => updatePage(ctx, p.id));
export const OPTIONS = preflight;
