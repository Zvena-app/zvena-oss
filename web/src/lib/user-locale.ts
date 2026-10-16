// Server-only: each person's interface language, as their last visit had it,
// so what the server writes to them later (Inbox items from the clock,
// letters) speaks it. English until known.

import { isLocale, type Locale } from "@/i18n/locales";
import { sql } from "./store";

let ready = false;
function ensure(): void {
  if (ready) return;
  sql("CREATE TABLE IF NOT EXISTS user_locale (user_id TEXT PRIMARY KEY, locale TEXT NOT NULL, at INTEGER NOT NULL)").run();
  sql("CREATE TRIGGER IF NOT EXISTS user_locale_gone AFTER DELETE ON users BEGIN DELETE FROM user_locale WHERE user_id = OLD.id; END").run();
  ready = true;
}

/** Notes the language (cheap: writes only when it changed). */
export function rememberUserLocale(userId: string, locale: string, now = Date.now()): void {
  if (!isLocale(locale)) return;
  ensure();
  sql("INSERT INTO user_locale (user_id, locale, at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET locale = excluded.locale, at = excluded.at WHERE user_locale.locale != excluded.locale").run(userId, locale, now);
}

export function userLocale(userId: string | null | undefined): Locale {
  if (!userId) return "en";
  ensure();
  const r = sql("SELECT locale FROM user_locale WHERE user_id = ?").get(userId) as { locale: string } | undefined;
  return r && isLocale(r.locale) ? r.locale : "en";
}
