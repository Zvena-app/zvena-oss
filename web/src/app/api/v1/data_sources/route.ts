import { createDataSource } from "@/lib/notes/api/handlers";
import { apiRoute, preflight } from "@/lib/notes/api/respond";

export const dynamic = "force-dynamic";

// POST /api/v1/data_sources { parent: { database_id }, title, properties, icon } — a further data source in a database (Notion API 2025-09-03).
export const POST = apiRoute("insert", (ctx) => createDataSource(ctx));
export const OPTIONS = preflight;
