import { auditCsv, auditEntries, auditFacets, type AuditQuery } from "@/lib/enterprise/audit-log";
import { ownerOnly } from "@/lib/enterprise/http";
import { json } from "@/lib/http";
import { audit } from "@/lib/store";

export const dynamic = "force-dynamic";

// Settings → Audit log (owner).
// GET ?ws=&actor=&action=&from=&to=&before=   → { entries, more, facets? }
// GET ?ws=…&format=csv                        → the filtered log as CSV (an export, itself in the log)
// from / to: ms since the epoch; action: exact actions or families ending in ".", comma-separated.

function query(url: URL): AuditQuery {
  const num = (k: string) => {
    const v = Number(url.searchParams.get(k));
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const actor = url.searchParams.get("actor");
  const action = url.searchParams.get("action");
  return {
    actor: actor && /^[\w:-]{1,80}$/.test(actor) ? actor : null,
    action: action && /^[a-z0-9.,-]{1,400}$/i.test(action) ? action : null,
    from: num("from"),
    to: num("to"),
    before: num("before"),
    limit: 100,
  };
}

export async function GET(req: Request) {
  const g = await ownerOnly(req, { scope: "ent-audit" });
  if (g instanceof Response) return g;
  const url = new URL(req.url);
  const q = query(url);
  if (url.searchParams.get("format") === "csv") {
    audit(g.user.id, "audit.export", g.ws);
    const lines = auditCsv(g.ws, q);
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        const n = lines.next();
        if (n.done) c.close();
        else c.enqueue(enc.encode(n.value));
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="zvena-audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  const page = auditEntries(g.ws, q);
  return json({ ...page, ...(url.searchParams.get("facets") === "1" ? { facets: auditFacets(g.ws) } : {}) });
}
