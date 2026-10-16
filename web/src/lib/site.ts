// The public pages (help, legal, status, source, the
// sign-in screens, invitations) has its own look — black and white, one sans typeface —
// apart from the app (Home, Docs, Team, Settings…). The root layout puts the
// `zs` class on <body> for these paths (app/site.css).

const SITE = /^\/(help|developers|legal(\/.*)?|source|status|report|signin(\/.*)?|consent|signout|join\/[^/]+|share\/[^/]+)?\/?$/;

export function isSitePath(path: string | null | undefined): boolean {
  return typeof path === "string" && SITE.test(path);
}

// Pages written in English only (help, legal). Whatever language a
// visitor picked for the app, these render as English — lang="en", left to
// right — so an Arabic or Hebrew choice never mirrors English text. The
// sign-in screens, consent, report and invitations are translated and follow
// the visitor's language.
const ENGLISH_ONLY = /^\/(help|developers|legal(\/.*)?|source|status)?\/?$/;

export function isEnglishOnlyPath(path: string | null | undefined): boolean {
  return typeof path === "string" && ENGLISH_ONLY.test(path);
}
