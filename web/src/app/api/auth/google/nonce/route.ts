import { config } from "@/lib/config";
import { fail, json } from "@/lib/http";
import { issueNonce } from "@/lib/google";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// GET /api/auth/google/nonce → { nonce } and an HttpOnly cookie with the same
// value: Google puts the nonce into the One Tap ID token, and the token is
// accepted only from the browser that holds the cookie.
export async function GET(req: Request) {
  const rl = rateLimited(req, "auth-onetap");
  if (rl) return rl;
  if (!config.google.enabled) return fail(404, "not found");
  const { nonce, cookie } = issueNonce();
  return json({ nonce }, 200, { "set-cookie": cookie });
}
