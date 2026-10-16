import { listTemplates } from "@/lib/notes/api/handlers";
import { apiRoute, preflight } from "@/lib/notes/api/respond";

export const dynamic = "force-dynamic";

// GET /api/v1/data_sources/{id}/templates — the data source's page templates (name, default).
export const GET = apiRoute<{ id: string }>("read", (ctx, p) => listTemplates(ctx, p.id));
export const OPTIONS = preflight;
