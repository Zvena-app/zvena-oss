// Runs once when a server process starts: the background upkeep
// (src/lib/maintenance.ts), the clock of scheduled database automations
// (src/lib/notes/automations-server.ts), Jev's hub that hears the
// workspaces' pulse (src/lib/decide/hub.ts) and the ecosystem's indexer of links
// (src/lib/eco), and every language's catalogs (src/i18n), on the Node
// runtime only.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Translations for server code outside pages (letters, API answers).
  await import("./i18n/server-catalogs");
  const { startMaintenance } = await import("./lib/maintenance");
  startMaintenance();
  const { startReminderTicker } = await import("./lib/notes/reminders-server");
  startReminderTicker();
  // Every Documents reaction is registered before the first scheduled write.
  await import("./lib/notes/reactions");
  const { startNotesScheduler } = await import("./lib/notes/automations-server");
  startNotesScheduler();
  // Documents' e-mail notifications: unread mentions, replies and comments, one letter per half hour at most.
  const { startMailDigests } = await import("./lib/notes/mail-digest");
  startMailDigests();
  const { startEco } = await import("./lib/eco/indexer");
  startEco();
  // Jev's hub: reactions and goals, live numbers from Documents and Projects, parents that
  // follow their sub-issues, and Projects' autopilot — everything zvena does by itself.
  const { startJev } = await import("./lib/decide/hub");
  startJev();
  // Calendar's clock: event reminders, subscriptions, CalDAV syncs (src/lib/calendar/reminders.ts).
  const { startCalendarTicker } = await import("./lib/calendar/reminders");
  startCalendarTicker();
  // Mail: every mailbox's sync worker and the outbox / snooze clock (ZVENA_MAIL_SYNC=off: none).
  const { startMail } = await import("./lib/mail-client/boot");
  startMail();
}
