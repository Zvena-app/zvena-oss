import { NextResponse } from "next/server";
import { formServable } from "@/lib/enterprise/site-domains";
import { rateLimited } from "@/lib/rate-limit";
import { rejectCrossSiteWrite, requestSelfOrigin } from "@/lib/request-guard";
import { readJsonCapped } from "@/lib/safe-json";
import { submitNoteForm } from "@/lib/notes/server-store";
import { currentUser } from "@/lib/http";
import "@/lib/notes/reactions";

export const dynamic = "force-dynamic";

// A response to a public zvena Documents form (/f/<id>): { answers } → { ok }.
// Anyone with the link may answer (or, for a members-only form, signed-in
// members); the answers are checked against the form's questions and saved
// as a new page of the owner's database, created by the member who answered
// unless the form is anonymous.

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rl = rateLimited(req, "notes-form");
  if (rl) return rl;
  if (rejectCrossSiteWrite(req, requestSelfOrigin(req))) return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
  const { id } = await params;
  // Its workspace turned publishing off: the link answers as if it were gone.
  if (!formServable(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const parsed = await readJsonCapped(req, 200_000);
  if (!parsed.ok) return NextResponse.json({ error: parsed.status === 413 ? "request too large" : "bad request" }, { status: parsed.status });
  try {
    const res = submitNoteForm(id, (parsed.value as { answers?: unknown } | null)?.answers, Date.now(), currentUser(req)?.user.id ?? null);
    if (res.ok) return NextResponse.json({ ok: true });
    return NextResponse.json({ error: res.error, ...(res.prop ? { prop: res.prop } : {}) }, { status: res.status });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
