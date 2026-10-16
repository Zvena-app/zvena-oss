import { appLinkPaths, iosAppIds } from "@/lib/app-links";

export const dynamic = "force-dynamic";

// GET /.well-known/apple-app-site-association — iOS universal links and the
// share extension's web credentials for the phone app (clients/mobile).
// App ids ("TEAMID.app.zvena.mobile") come from ZVENA_IOS_APP_ID (comma-
// separated); without one there is no app to associate: 404.

export function GET() {
  const ids = iosAppIds();
  if (!ids.length) return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  const body = {
    applinks: { details: [{ appIDs: ids, components: appLinkPaths().map((p) => ({ "/": p, comment: "zvena" })) }] },
    webcredentials: { apps: ids },
  };
  return Response.json(body, { headers: { "cache-control": "public, max-age=3600" } });
}
