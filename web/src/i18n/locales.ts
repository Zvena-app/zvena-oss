// The languages of zvena's interface: English first (the default and the
// source of every string), then the most-spoken languages of the world
// (Ethnologue). Pure data and helpers, shared by the server and the browser.

export const LOCALES = ["en", "zh", "hi", "es", "ar", "fr", "bn", "pt", "ru", "id"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

export interface LocaleInfo {
  /** The language's own name, as the language picker shows it. */
  native: string;
  english: string;
  dir: "ltr" | "rtl";
  /** The tag for Intl (dates, numbers, plurals). */
  intl: string;
}

export const LOCALE_INFO: Record<Locale, LocaleInfo> = {
  en: { native: "English", english: "English", dir: "ltr", intl: "en-US" },
  zh: { native: "简体中文", english: "Chinese (Simplified)", dir: "ltr", intl: "zh-CN" },
  hi: { native: "हिन्दी", english: "Hindi", dir: "ltr", intl: "hi-IN" },
  es: { native: "Español", english: "Spanish", dir: "ltr", intl: "es" },
  ar: { native: "العربية", english: "Arabic", dir: "rtl", intl: "ar" },
  fr: { native: "Français", english: "French", dir: "ltr", intl: "fr-FR" },
  bn: { native: "বাংলা", english: "Bengali", dir: "ltr", intl: "bn-BD" },
  pt: { native: "Português", english: "Portuguese", dir: "ltr", intl: "pt-BR" },
  ru: { native: "Русский", english: "Russian", dir: "ltr", intl: "ru" },
  id: { native: "Bahasa Indonesia", english: "Indonesian", dir: "ltr", intl: "id-ID" },
};

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}

/** The interface language for a language tag ("pt-BR" → "pt", "zh-Hans-CN" → "zh"), or null. */
export function localeOfTag(tag: string): Locale | null {
  const base = tag.trim().toLowerCase().split(/[-_]/)[0];
  return isLocale(base) ? base : null;
}

export function intlTag(l: Locale): string {
  return LOCALE_INFO[l].intl;
}

/** The Intl tag for any language code the app passes around ("ru", "es"…); English for anything else. */
export function intlOf(l: string): string {
  return isLocale(l) ? LOCALE_INFO[l].intl : LOCALE_INFO.en.intl;
}

/** "Today", "Tomorrow", "Yesterday" (n = 0, 1, -1 days) in the language, capitalised. */
export function nearDay(l: string, n: number): string {
  const tag = intlOf(l);
  const w = new Intl.RelativeTimeFormat(tag, { numeric: "auto" }).format(n, "day");
  return w.charAt(0).toLocaleUpperCase(tag) + w.slice(1);
}

/** Languages whose calendars start on Monday (CLDR, for browsers without Intl week info). */
const MONDAY_FIRST: ReadonlySet<string> = new Set(["zh", "es", "fr", "ru"]);

/** Whether weeks start on Monday in the language (its region's calendar). */
export function mondayFirstIn(l: string): boolean {
  try {
    const loc = new Intl.Locale(intlOf(l)) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const first = loc.getWeekInfo?.().firstDay ?? loc.weekInfo?.firstDay;
    if (first) return first === 1;
  } catch {
    // Old engines: the table below.
  }
  return MONDAY_FIRST.has(l);
}

/** The day weeks start on in the language's region: 0 Sunday … 6 Saturday (en-US Sunday, most of Europe Monday). */
export function weekStartIn(l: string): number {
  try {
    const loc = new Intl.Locale(intlOf(l)) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const first = loc.getWeekInfo?.().firstDay ?? loc.weekInfo?.firstDay;
    if (first) return first % 7;
  } catch {
    // Old engines: the table below.
  }
  return MONDAY_FIRST.has(l) ? 1 : 0;
}

/**
 * Weekday names from the week's first day in the language (weekStartIn), or
 * from `start` (0 Sunday … 6 Saturday): "Sun"…"Sat", "Пн"…"Вс", "周一"…"周日",
 * capitalised. "compact" is for narrow day grids: the short names, or the
 * narrow ones where the short ones are long (Arabic "الثلاثاء" → "ث").
 */
export function weekdayNames(l: string, style: "short" | "compact" = "short", start = weekStartIn(l)): string[] {
  const tag = intlOf(l);
  const names = (weekday: "short" | "narrow") => {
    const f = new Intl.DateTimeFormat(tag, { weekday, timeZone: "UTC" });
    // 2024-01-07 was a Sunday.
    return Array.from({ length: 7 }, (_, i) => {
      const w = f.format(new Date(Date.UTC(2024, 0, 7 + ((start + i) % 7))));
      return w.charAt(0).toLocaleUpperCase(tag) + w.slice(1);
    });
  };
  const short = names("short");
  return style === "compact" && short.some((w) => [...w].length > 4) ? names("narrow") : short;
}

/** Monday-first weekday names (see weekdayNames). */
export const weekdaysMondayFirst = (l: string, style: "short" | "compact" = "short"): string[] => weekdayNames(l, style, 1);

export function dirOf(l: Locale): "ltr" | "rtl" {
  return LOCALE_INFO[l].dir;
}

/** For data kept in English and Russian only (design templates, sample content): Russian, else English. */
export function enRu(l: string): "en" | "ru" {
  return l === "ru" ? "ru" : "en";
}

/** CLDR plural category of `n` in the language ("one", "few", "many", "other"…). */
export function pluralOf(l: Locale, n: number): Intl.LDMLPluralRule {
  return new Intl.PluralRules(intlTag(l)).select(n);
}
