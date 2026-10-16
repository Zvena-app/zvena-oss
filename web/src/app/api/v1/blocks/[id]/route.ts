import { deleteBlock, getBlock, updateBlockById } from "@/lib/notes/api/handlers";
import { apiRoute, preflight } from "@/lib/notes/api/respond";

export const dynamic = "force-dynamic";

// GET    /api/v1/blocks/{id} — a block (a page or database id gives its child_page / child_database block).
// PATCH  /api/v1/blocks/{id} { <type>: { … }, in_trash } — changes its content.
// DELETE /api/v1/blocks/{id} — removes it (a page goes to the trash).
export const GET = apiRoute<{ id: string }>("read", (ctx, p) => getBlock(ctx, p.id));
export const PATCH = apiRoute<{ id: string }>("update", (ctx, p) => updateBlockById(ctx, p.id));
export const DELETE = apiRoute<{ id: string }>("update", (ctx, p) => deleteBlock(ctx, p.id));
export const OPTIONS = preflight;
