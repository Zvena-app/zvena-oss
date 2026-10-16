// Legacy stored values. Releases before 2026-10-16 stored the decision model's
// former internal name in a few places (a settings column, decision sources,
// history rows, Inbox kinds, audit actions, automation run notes and the
// "run only if" field of Documents automations). This is the one file allowed
// to spell that name (scripts/check-no-ai.mjs); nothing here is ever shown.
//
// lib/legacy-migrate.ts rewrites what it can in place when the store opens.
// Automations inside Documents databases are JSON in each page (and in devices'
// copies) and are mapped when read instead (lib/notes/automations.ts).

/** Legacy stored value: the former name, as stored by earlier releases. */
export const LEGACY_NAME = "jev"; // legacy stored value

/** Legacy stored value: the key of a Documents automation's "run only if" condition. */
export const LEGACY_ONLY_IF_FIELD = LEGACY_NAME;
