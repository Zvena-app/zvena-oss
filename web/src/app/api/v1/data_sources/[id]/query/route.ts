import { queryDataSource } from "@/lib/notes/api/handlers";
import { apiRoute, preflight } from "@/lib/notes/api/respond";

export const dynamic = "force-dynamic";

// POST /api/v1/data_sources/{id}/query { filter, sorts, start_cursor, page_size } — the data source's rows.
export const POST = apiRoute<{ id: string }>("read", (ctx, p) => queryDataSource(ctx, p.id));
export const OPTIONS = preflight;
