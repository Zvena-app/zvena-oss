import { config } from "@/lib/config";
import { setTestRecords } from "@/lib/enterprise/dns";
import { normalizeDomain } from "@/lib/enterprise/hosts";
import { crossSite, currentUser, fail, json } from "@/lib/http";
import { readJsonCapped } from "@/lib/safe-json";

export const dynamic = "force-dynamic";

// POST /api/enterprise/test-dns { type: "txt" | "cname", name, values } —
// a test stand only (ZVENA_STAND=test with the test sign-in on; 404 anywhere
// else): DNS answers for domain checks, so browser checks can verify domains
// nobody owns. Signed-in people only.
export async function POST(req: Request) {
  if (!config.devLogin) return fail(404, "not found");
  const bad = crossSite(req);
  if (bad) return bad;
  if (!currentUser(req)) return fail(401, "unauthorized");
  const p = await readJsonCapped(req, 10_000);
  const b = (p.ok && typeof p.value === "object" && p.value !== null ? p.value : {}) as { type?: unknown; name?: unknown; values?: unknown };
  const name = typeof b.name === "string" ? (b.name.startsWith("_") ? b.name.toLowerCase() : normalizeDomain(b.name)) : null;
  if ((b.type !== "txt" && b.type !== "cname") || !name || !/^[a-z0-9_.-]{3,253}$/.test(name) || !Array.isArray(b.values)) return fail(400, "bad request");
  setTestRecords(b.type, name, b.values.map(String));
  return json({ ok: true });
}
