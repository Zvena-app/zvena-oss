// Background upkeep of the web app, started once per server process
// (src/instrumentation.ts) — no separate cron service to forget about:
//   hourly  expired sessions/codes/presence, retries of Design deletions
//           left by account deletion, due-date reminders of Projects, cycles
//           that ended (their unfinished issues roll over to the next one),
//           suggestions and the decision log past their retention
//   daily   guest uploads unused for the TTL (people were warned in the
//           banner), expired invites, the security journal past a year,
//           map address lookups past 30 days, page history thinning
//           (lib/notes/versions.ts), wiki verifications that ran out
//           (lib/notes/verification-server.ts)
// Each run logs one line with counts only (no personal data).

import { retryDesignDeletions } from "./account";
import { sendDueReminders } from "./projects/issues";
import { rollOverCycles } from "./projects/planning";
import { pruneSuggestions } from "./projects/autopilot";
import { pruneDecisions } from "./decide/engine";
import { pruneConversions } from "./projects/from-doc";
import { purgeGeoCache, warnMapsContact } from "./maps";
import { verificationUpkeep } from "./notes/verification-server";
import { pruneHistory } from "./notes/versions";
import { cleanupGuests } from "./storage";
import { sql, sweepExpired } from "./store";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const AUDIT_KEEP = 365 * DAY;

function lastRun(key: string): number {
  const row = sql("SELECT v FROM kv WHERE k = ?").get(`maint:${key}`) as { v: string } | undefined;
  return row ? Number(row.v) || 0 : 0;
}

function markRun(key: string, at: number): void {
  sql("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(`maint:${key}`, String(at));
}

export async function runMaintenance(now = Date.now()): Promise<Record<string, number>> {
  const done: Record<string, number> = {};
  sweepExpired(now);
  done.designDeletionsLeft = await retryDesignDeletions();
  done.dueReminders = sendDueReminders(now);
  done.cyclesRolledOver = rollOverCycles(now);
  done.suggestionsPruned = pruneSuggestions(now);
  done.decisionsPruned = pruneDecisions(now);
  done.docConversionsPruned = pruneConversions(now);
  if (now - lastRun("daily") >= DAY - 5 * 60_000) {
    const g = await cleanupGuests(now);
    done.guests = g.guests;
    done.guestFiles = g.files;
    done.invites = Number(sql("DELETE FROM invites WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)").run(now - 30 * DAY, now - 30 * DAY).changes);
    done.audit = Number(sql("DELETE FROM audit WHERE at < ?").run(now - AUDIT_KEEP).changes);
    done.geo = purgeGeoCache(now);
    const h = pruneHistory(now);
    done.versions = h.versions;
    done.noteEvents = h.events;
    done.noteViews = h.views;
    // Wiki pages past their verification day go back to unverified; owners hear of it.
    const v = verificationUpkeep(now);
    done.verifyExpired = v.expired;
    done.verifyWarned = v.warned;
    markRun("daily", now);
  }
  return done;
}

let started = false;

export function startMaintenance(): void {
  // At start-up: OpenStreetMap needs the operator's contact (ZVENA_MAPS_CONTACT) — a warning in the log when it is missing.
  warnMapsContact();
  if (started || process.env.ZVENA_MAINTENANCE === "off") return;
  started = true;
  const tick = () =>
    runMaintenance()
      .then((d) => console.log(`[maintenance] ${Object.entries(d).map(([k, v]) => `${k}=${v}`).join(" ")}`))
      .catch((e) => console.error(`[maintenance] failed (${e instanceof Error ? e.name : "error"})`));
  setTimeout(tick, 60_000).unref();
  setInterval(tick, HOUR).unref();
}
