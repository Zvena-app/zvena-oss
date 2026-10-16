import { getPageProperty } from "@/lib/notes/api/handlers";
import { apiRoute, preflight } from "@/lib/notes/api/respond";

export const dynamic = "force-dynamic";

// GET /api/v1/pages/{id}/properties/{property_id} — one property value (lists paginated).
export const GET = apiRoute<{ id: string; prop: string }>("read", (ctx, p) => getPageProperty(ctx, p.id, p.prop));
export const OPTIONS = preflight;
