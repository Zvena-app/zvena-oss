import { appendChildren, listChildren } from "@/lib/notes/api/handlers";
import { apiRoute, preflight } from "@/lib/notes/api/respond";

export const dynamic = "force-dynamic";

// GET   /api/v1/blocks/{id}/children — the blocks of a page, or under a block.
// PATCH /api/v1/blocks/{id}/children { children, after } — appends blocks (after a child, or at the end).
export const GET = apiRoute<{ id: string }>("read", (ctx, p) => listChildren(ctx, p.id));
export const PATCH = apiRoute<{ id: string }>("insert", (ctx, p) => appendChildren(ctx, p.id));
export const OPTIONS = preflight;
