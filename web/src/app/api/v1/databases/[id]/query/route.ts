import { queryDatabase } from "@/lib/notes/api/handlers";
import { apiRoute, preflight } from "@/lib/notes/api/respond";

export const dynamic = "force-dynamic";

// POST /api/v1/databases/{id}/query { filter, sorts, start_cursor, page_size } — the database's rows.
export const POST = apiRoute<{ id: string }>("read", (ctx, p) => queryDatabase(ctx, p.id));
export const OPTIONS = preflight;
