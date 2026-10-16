import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

// GET /.well-known/security.txt (RFC 9116): where to report a vulnerability.
// The contact is the support address (ZVENA_CONTACT_EMAIL); Expires moves a
// year ahead on its own, so the file never goes stale.

export function GET() {
  const expires = new Date(Date.now() + 365 * 86_400_000);
  expires.setUTCHours(0, 0, 0, 0);
  const body = [
    `Contact: mailto:${config.company.email}`,
    `Expires: ${expires.toISOString()}`,
    "Preferred-Languages: en",
    `Canonical: ${config.appUrl}/.well-known/security.txt`,
    `Policy: ${config.appUrl}/legal/terms#acceptable-use`,
    "",
  ].join("\n");
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=86400" } });
}
