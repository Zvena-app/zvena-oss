import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// POST /share-target — the installed app's share target (app/manifest.ts).
// The service worker answers it itself (files go to Documents' import); this
// is the answer when no worker runs: the shared link and text open the /clip
// page, where the person picks a place and presses Save. Nothing is saved
// here, so a form posted from another site can at most prefill that page;
// the browser marks a system share "Sec-Fetch-Site: none" and other sites
// "cross-site", which is refused anyway.

const MAX = 64_000;

export async function POST(req: Request) {
  const rl = rateLimited(req, "notes-clip");
  if (rl) return rl;
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "none" && site !== "same-origin") return new NextResponse("forbidden", { status: 403 });
  const declared = Number(req.headers.get("content-length") ?? "0");
  const q = new URLSearchParams();
  if (declared <= 25 * 1024 * 1024) {
    try {
      const fd = await req.formData();
      for (const k of ["url", "title", "text"]) {
        const v = fd.get(k);
        if (typeof v === "string" && v.trim()) q.set(k, v.trim().slice(0, k === "text" ? 4000 : 2000));
      }
    } catch {
      // Not a form: the page opens empty.
    }
  }
  const to = `/clip${q.size ? `?${q.toString()}` : ""}`;
  return new NextResponse(null, { status: 303, headers: { location: to.length > MAX ? "/clip" : to, "cache-control": "no-store" } });
}
