// A full page load to a page of this app, on purpose instead of useRouter().push().
// Used after a session or workspace change (sign-out, account deletion, joining,
// leaving, creating or switching a workspace) and when leaving one section for
// another whose state lives in the client (Docs' local store, live connections):
// a soft navigation would keep the router cache and those client-side states of
// the old session or workspace. Next's lint rule against relative `location.href`
// does not see through this function; that is the point of having one place for it.

/** Load `path` (same origin) as a new document. */
export function hardNavigate(path: string): void {
  window.location.assign(path);
}
