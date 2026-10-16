import { androidAppLinks } from "@/lib/app-links";

export const dynamic = "force-dynamic";

// GET /.well-known/assetlinks.json — Android App Links for the phone app
// (clients/mobile): links to zvena open in the app once Android verifies
// this file. ZVENA_ANDROID_PACKAGE (default app.zvena.mobile) and
// ZVENA_ANDROID_CERT_SHA256 (the signing certificates' SHA-256
// fingerprints, comma-separated); without a fingerprint: 404.

export function GET() {
  const links = androidAppLinks();
  if (!links) return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  return Response.json(links, { headers: { "cache-control": "public, max-age=3600" } });
}
