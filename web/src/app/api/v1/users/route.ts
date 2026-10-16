import { listUsers } from "@/lib/notes/api/handlers";
import { apiRoute, preflight } from "@/lib/notes/api/respond";

export const dynamic = "force-dynamic";

// GET /api/v1/users — the workspace's people and bots (Notion's "List all users").
export const GET = apiRoute("users", (ctx) => listUsers(ctx));
export const OPTIONS = preflight;
