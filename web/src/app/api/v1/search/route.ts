import { search } from "@/lib/notes/api/handlers";
import { apiRoute, preflight } from "@/lib/notes/api/respond";

export const dynamic = "force-dynamic";

// POST /api/v1/search { query, filter, sort, start_cursor, page_size } — pages and databases shared with the integration, by title.
export const POST = apiRoute("read", (ctx) => search(ctx));
export const OPTIONS = preflight;
