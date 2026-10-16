import { body, ownerOnly } from "@/lib/enterprise/http";
import { securityOf, updateSecurity } from "@/lib/enterprise/security";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

// Settings → Security of a workspace (owner).
// GET   ?ws=                → { settings }
// PATCH ?ws= { …settings }  → { settings }   (only the fields sent change)

export async function GET(req: Request) {
  const g = await ownerOnly(req);
  if (g instanceof Response) return g;
  return json({ settings: securityOf(g.ws), personal: g.personal });
}

export async function PATCH(req: Request) {
  const g = await ownerOnly(req);
  if (g instanceof Response) return g;
  return json({ settings: updateSecurity(g.ws, g.user.id, await body(req, 4_000)) });
}
