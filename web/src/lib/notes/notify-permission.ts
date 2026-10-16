// zvena Documents: asking for notifications when someone sets a reminder (a
// click: browsers want one). Once allowed, Notes sends the reminders out as
// push at once (NotesApp listens for "nt-remind-permission").

export const PERMISSION_EVENT = "nt-remind-permission";

/** True while asking makes sense: the browser can notify and nobody answered yet. */
export function canAskReminders(): boolean {
  return typeof Notification !== "undefined" && Notification.permission === "default";
}

/** What this browser does with a reminder while Notes is closed. */
export type ReminderReach = "push" | "ask" | "denied" | "tab";

export function reminderReach(): ReminderReach {
  if (typeof Notification === "undefined") return "tab";
  if (Notification.permission === "denied") return "denied";
  if (typeof window === "undefined" || !("PushManager" in window) || !("serviceWorker" in navigator)) return "tab";
  return Notification.permission === "granted" ? "push" : "ask";
}

/** Resolves with the answer (null: nothing was asked). */
export function askReminderPermission(): Promise<NotificationPermission | null> {
  if (!canAskReminders()) return Promise.resolve(null);
  return Notification.requestPermission()
    .then((p) => {
      if (p === "granted") window.dispatchEvent(new Event(PERMISSION_EVENT));
      return p;
    })
    .catch(() => null);
}
