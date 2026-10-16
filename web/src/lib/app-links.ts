// Universal links (iOS) and App Links (Android) of the phone apps
// (clients/mobile): which app may open which zvena addresses. Values come
// from the environment, so the web app ships without them and a server
// associates only the apps its owner signed.

/** Addresses that open in the app (the rest of the site stays in the browser). */
const PATHS = ["/docs", "/docs/*", "/n/*", "/share/*", "/join/*", "/projects", "/projects/*", "/home", "/inbox", "/clip"];

export function appLinkPaths(): string[] {
  return PATHS;
}

const IOS_ID_RE = /^[A-Z0-9]{10}\.[A-Za-z0-9.-]{3,200}$/;
const PKG_RE = /^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/;
const SHA_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/** ZVENA_IOS_APP_ID: "TEAMID.bundle.id" entries, comma-separated (bad ones are dropped). */
export function iosAppIds(env: Record<string, string | undefined> = process.env): string[] {
  return (env.ZVENA_IOS_APP_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => IOS_ID_RE.test(s));
}

/** The assetlinks.json statements, or null without a valid package and fingerprint. */
export function androidAppLinks(env: Record<string, string | undefined> = process.env): unknown[] | null {
  const pkg = (env.ZVENA_ANDROID_PACKAGE || "app.zvena.mobile").trim();
  const prints = (env.ZVENA_ANDROID_CERT_SHA256 || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => SHA_RE.test(s));
  if (!PKG_RE.test(pkg) || !prints.length) return null;
  return [{ relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: prints } }];
}
