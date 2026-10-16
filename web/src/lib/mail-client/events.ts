// Server-only: telling people about their mail. Mail is personal, so both
// channels reach the mailbox's owner only:
//   - the pulse: a "mail" poke (ids only: ref = the owner's user id, the
//     account id) on each of the owner's workspaces; the pulse filter
//     (lib/eco/visibility.ts) sends it to the owner and nobody else, and the
//     open Mail tab pulls what changed through /api/mail;
//   - zvena's Inbox (lib/eco/inbox.ts notify), for new mail in the views the
//     person turned notifications on for (none by default: Notion Mail's
//     "important views only"), in the workspace they last opened Mail in.

import { notify } from "../eco/inbox";
import { emit } from "../pulse/bus";
import { sql } from "../store";
import { workspacesOf } from "../workspaces";
import { prefsOf, viewsOf } from "./prefs";
import { labelIdsOf, matchableOf, messageRowByN, type AccountRow } from "./store";
import { matches } from "./views";

/** Pokes the owner's open Mail tabs: something in their mail changed (`fresh`: new messages). */
export function mailChanged(userId: string, accountId: string, fresh = 0): void {
  for (const w of workspacesOf(userId)) emit(w.id, { type: "mail", ref: userId, data: { account: accountId, fresh } });
}

/** The workspace whose Inbox gets the person's mail notifications. */
export function notifyWorkspace(userId: string): string | null {
  const p = prefsOf(userId);
  if (p.ws && sql("SELECT 1 FROM members WHERE ws_id = ? AND user_id = ?").get(p.ws, userId)) return p.ws;
  return (sql("SELECT id FROM workspaces WHERE owner_id = ? AND personal = 1").get(userId) as { id: string } | undefined)?.id ?? null;
}

/** New mail in a view with notifications on → one Inbox item per conversation. */
export function notifyFresh(acct: AccountRow, fresh: { n: number; threadId: string }[]): number {
  const views = viewsOf(acct.user_id).filter((v) => v.notify);
  if (!views.length || !fresh.length) return 0;
  const ws = notifyWorkspace(acct.user_id);
  if (!ws) return 0;
  const labels = labelIdsOf(fresh.map((f) => f.n));
  const done = new Set<string>();
  const now = Date.now();
  for (const f of fresh.slice(0, 100)) {
    if (done.has(f.threadId)) continue;
    const r = messageRowByN(f.n);
    if (!r || r.seen === 1 || now - Number(r.date) > 3 * 86_400_000) continue;
    const m = matchableOf(r, labels.get(f.n) ?? []);
    if (!views.some((v) => matches(m, v.filter, now))) continue;
    done.add(f.threadId);
    // An excerpt only (who and what): the card shows the conversation to its owner alone.
    notify(acct.user_id, { ws, kind: "mail", ref: `mail:${f.threadId}`, by: null, text: `${r.from_name || r.from_addr}: ${r.subject}`.slice(0, 280) });
  }
  return done.size;
}
