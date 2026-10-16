// Server-only: rewrites values stored by earlier releases under the decision
// model's former name (lib/legacy-names.ts) to the current names, when the
// store opens. Idempotent UPDATEs, each only where its table exists; no table
// is rebuilt and no CHECK constraint is involved.

import type { DatabaseSync } from "node:sqlite";
import { LEGACY_NAME as OLD } from "./legacy-names";

function columns(d: DatabaseSync, table: string): Set<string> {
  return new Set((d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
}

/** Rewrites legacy stored values to the current names (each step only where its table exists). */
export function renameLegacyValues(d: DatabaseSync): void {
  const has = (t: string) => columns(d, t).size > 0;
  // The workspace switch: a new column, copied once from the legacy one (kept, unused, so an older release still reads it).
  if (has("dz_settings")) {
    const cols = columns(d, "dz_settings");
    if (!cols.has("smart")) {
      d.exec("ALTER TABLE dz_settings ADD COLUMN smart INTEGER NOT NULL DEFAULT 0");
      if (cols.has(OLD)) d.exec(`UPDATE dz_settings SET smart = ${OLD}`);
    }
  }
  if (has("dz_decisions")) {
    d.prepare("UPDATE dz_decisions SET source = 'model' WHERE source = ?").run(OLD);
    // A Documents automation's condition as the decision saved it.
    d.prepare("UPDATE dz_decisions SET actions = json_set(json_remove(actions, ?), '$.onlyIf', json_extract(actions, ?)) WHERE actions IS NOT NULL AND json_valid(actions) AND json_type(actions, ?) IS NOT NULL").run(`$.${OLD}`, `$.${OLD}`, `$.${OLD}`);
  }
  if (has("pj_activity") && columns(d, "pj_activity").has("via")) d.prepare("UPDATE pj_activity SET via = 'auto' WHERE via = ?").run(OLD);
  if (has("eco_inbox")) d.prepare("UPDATE eco_inbox SET kind = 'proposal' WHERE kind = ?").run(OLD);
  if (has("audit")) {
    d.prepare("UPDATE audit SET action = 'decide.smart.on' WHERE action = ?").run(`decide.${OLD}.on`);
    d.prepare("UPDATE audit SET action = 'decide.smart.off' WHERE action = ?").run(`decide.${OLD}.off`);
  }
  // Why an automation did not run, as its last run shows it (lib/decide/docs-smart.ts writes the current wording).
  if (has("note_automation_runs")) {
    const runs = d.prepare("SELECT rowid AS id, error FROM note_automation_runs WHERE error LIKE ?").all(`%${OLD}%`) as { id: number; error: string }[];
    const set = d.prepare("UPDATE note_automation_runs SET error = ? WHERE rowid = ?");
    for (const r of runs) set.run(legacyRunNote(r.error), r.id);
  }
}

/** The current wording of a legacy "why it did not run" note. */
function legacyRunNote(error: string): string {
  const no = /\((\d+)%\)/.exec(error);
  if (/said no/i.test(error)) return no ? `condition not met (${no[1]}%)` : "condition not met";
  if (/did not answer/i.test(error)) return "the condition could not be checked in time";
  if (/too many/i.test(error)) return "too many checks this hour";
  if (/nothing .* may read/i.test(error)) return "no property the condition may read";
  if (/not available/i.test(error)) return "the condition cannot be checked here";
  return "smart suggestions and automations are off";
}
