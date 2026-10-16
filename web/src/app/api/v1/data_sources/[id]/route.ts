import { getDataSource, updateDataSource } from "@/lib/notes/api/handlers";
import { apiRoute, preflight } from "@/lib/notes/api/respond";

export const dynamic = "force-dynamic";

// GET   /api/v1/data_sources/{id} — a data source and its property schema (Notion API 2025-09-03).
// PATCH /api/v1/data_sources/{id} { title, icon, properties, in_trash, parent: { database_id } } — renames, changes properties, moves it to another database.
export const GET = apiRoute<{ id: string }>("read", (ctx, p) => getDataSource(ctx, p.id));
export const PATCH = apiRoute<{ id: string }>("update", (ctx, p) => updateDataSource(ctx, p.id));
export const OPTIONS = preflight;
