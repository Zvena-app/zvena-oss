// zvena Documents: when the workspace may open this device's pages before the
// session and sync round trips. Pure: NotesApp and the tests.

/**
 * `owner`: whose pages the local store holds (account:workspace, or "" for a
 * guest's). `serverKey`: the same key for who the server saw signed in when
 * the page loaded ("" = nobody, undefined = it did not say). Only the same
 * key shows early; any other store waits for sync to replace it, so another
 * person's or another workspace's pages never flash. A first visit (nothing
 * stored yet) waits as before.
 */
export function showLocalPagesEarly(owner: string, seeded: boolean, pages: number, serverKey: string | undefined): boolean {
  if (serverKey === undefined || !seeded || pages === 0) return false;
  return owner === serverKey;
}
