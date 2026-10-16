// The editor's own strings (BlockNote's menus, placeholders) in the interface
// language: BlockNote ships most of zvena's languages; the rest get English.

import * as locales from "@blocknote/core/locales";

type Dictionary = typeof locales.en;

const BY_LOCALE: Record<string, Dictionary | undefined> = {
  en: locales.en,
  ru: locales.ru as Dictionary,
  zh: locales.zh as Dictionary,
  es: locales.es as Dictionary,
  fr: locales.fr as Dictionary,
  pt: locales.pt as Dictionary,
  ar: locales.ar as Dictionary,
};

export function blockNoteLocale(locale: string): Dictionary {
  return BY_LOCALE[locale] ?? locales.en;
}
