// Server-only: the sync stamp of Documents — strictly increasing for the
// whole database. Every write (a note saved, a note re-stamped after an
// access change, an access revoked) takes the next one, and devices pull
// what is newer than their cursor.
//
// The last stamp lives in the database (kv), read and written inside a
// write transaction: Next bundles each route and instrumentation (where
// automations and reminders run) separately, so a module variable would
// exist once per bundle and two writes could share a stamp — a device whose
// cursor landed between them would never pull the second. A clock set back
// (NTP, a restored VM) cannot hand out stamps below cursors devices hold.

import { sql, tx } from "../store";

const KEY = "notes:stamp";

export function nextStamp(): number {
  return tx(() => {
    const row = sql("SELECT v FROM kv WHERE k = ?").get(KEY) as { v: string } | undefined;
    let last = row ? Number(row.v) : NaN;
    if (!Number.isFinite(last)) {
      // First use on this database: continue above everything already stamped.
      const notes = Number((sql("SELECT COALESCE(MAX(stamp), 0) AS s FROM notes").get() as { s: number }).s);
      const revoked = Number((sql("SELECT COALESCE(MAX(stamp), 0) AS s FROM note_revoked").get() as { s: number }).s);
      last = Math.max(notes, revoked);
    }
    const next = Math.max(Date.now(), last + 1);
    sql("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(KEY, String(next));
    return next;
  });
}
