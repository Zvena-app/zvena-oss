import { createDatabase } from "@/lib/notes/api/handlers";
import { apiRoute, preflight } from "@/lib/notes/api/respond";

export const dynamic = "force-dynamic";

// POST /api/v1/databases { parent: { page_id }, title, properties, is_inline } — a new database inside a page.
export const POST = apiRoute("insert", (ctx) => createDatabase(ctx));
export const OPTIONS = preflight;
