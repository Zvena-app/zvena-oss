"use client";

import { msg } from "@/i18n/runtime";

// The words of "+ Create" and "What will you create?". Kept with the
// components (like components/eco/i18n.ts) so they can sit on any surface;
// the language is the page's <html lang>.

const en = {
  create: "Create",
  heroTitle: "What will you create?",
  search: "Search: presentation, table, task…",
  write: "Write",
  plan: "Plan",
  design: "Design",
  templates: "Start from a template",
  allTemplates: "All templates",
  more: "More",
  nothing: "Nothing matches. Try “doc”, “presentation” or “task”.",
  close: "Close",
  readOnly: "You can view this workspace but not add to it.",
};

const ru: typeof en = {
  create: "Создать",
  heroTitle: "Что создадим?",
  search: "Поиск: презентация, таблица, задача…",
  write: "Писать",
  plan: "Планировать",
  design: "Дизайн",
  templates: "Начать с шаблона",
  allTemplates: "Все шаблоны",
  more: "Ещё",
  nothing: "Ничего не нашлось. Попробуйте «документ», «презентация» или «задача».",
  close: "Закрыть",
  readOnly: "В этом пространстве можно смотреть, но не добавлять.",
};

export type CreateKey = keyof typeof en;

export function createLocale(): string {
  return typeof document !== "undefined" ? document.documentElement.lang || "en" : "en";
}

/** English and Russian are here; the other languages come from src/i18n/catalogs/ds/ (keys "create.*"). */
export function ct(key: CreateKey, locale: string = createLocale()): string {
  if (locale === "ru") return ru[key];
  return (locale === "en" ? undefined : msg("ds", locale, `create.${key}`)) ?? en[key];
}
