import { createPage } from "@/lib/notes/api/handlers";
import { apiRoute, preflight } from "@/lib/notes/api/respond";

export const dynamic = "force-dynamic";

// POST /api/v1/pages { parent: { page_id | database_id }, properties, children, icon, cover } — a sub-page or a database row.
export const POST = apiRoute("insert", (ctx) => createPage(ctx));
export const OPTIONS = preflight;
