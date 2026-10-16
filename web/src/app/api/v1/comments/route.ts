import { createComment, listComments } from "@/lib/notes/api/handlers";
import { apiRoute, preflight } from "@/lib/notes/api/respond";

export const dynamic = "force-dynamic";

// GET  /api/v1/comments?block_id= — open discussions of a page (page id) or of a block.
// POST /api/v1/comments { parent: { page_id } | discussion_id, rich_text } — a new comment or a reply.
export const GET = apiRoute("readComments", (ctx) => listComments(ctx));
export const POST = apiRoute("insertComments", (ctx) => createComment(ctx));
export const OPTIONS = preflight;
