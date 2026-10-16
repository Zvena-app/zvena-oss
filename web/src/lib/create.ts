// What a person can make in zvena, the way Canva's "Create a design" lists it:
// one list for the "+ Create" button, the "What will you create?" hero on
// Home and Cmd+K, so making something looks and works the same everywhere.
// Every item is one click: /new (app/new/route.ts) makes it and opens the
// editor on it. Client-safe (no server imports). Labels: English and Russian
// here, the other languages in src/i18n/catalogs/ds/ (item.<id>.label|hint, tpl.<id>).

import { msg } from "@/i18n/runtime";

export type CreateKind = "doc" | "table" | "issue" | "design";

export type CreateGroup = "write" | "plan" | "design";

export interface CreateItem {
  id: string;
  kind: CreateKind;
  group: CreateGroup;
  /** Design: a format preset (one empty board of that size, templates/design-presets/). */
  preset?: DesignPreset;
  /** The board size shown on the tile. */
  size?: [number, number];
  label: { en: string; ru: string };
  hint: { en: string; ru: string };
  /** Words people search with, both languages. */
  words: string;
  /** The tile's color: a --ui-tint-* face (components/zvena/ds/ds.css), light and dark. */
  tint: string;
}

export const DESIGN_PRESETS = ["presentation", "social", "story", "mobile", "website", "a4"] as const;
export type DesignPreset = (typeof DESIGN_PRESETS)[number];

export const CREATE_ITEMS: readonly CreateItem[] = [
  { id: "doc", kind: "doc", group: "write", label: { en: "Doc", ru: "Документ" }, hint: { en: "Notes, plans, wikis", ru: "Заметки, планы, вики" }, words: "doc document page note text документ страница заметка текст", tint: "var(--ui-tint-blue)" },
  { id: "table", kind: "table", group: "plan", label: { en: "Table", ru: "Таблица" }, hint: { en: "A database with views", ru: "База с видами" }, words: "table database list tracker таблица база список трекер", tint: "var(--ui-tint-green)" },
  { id: "issue", kind: "issue", group: "plan", label: { en: "Task", ru: "Задача" }, hint: { en: "An issue in Projects", ru: "Задача в Проектах" }, words: "task issue todo bug задача баг дело", tint: "var(--ui-tint-orange)" },
  { id: "presentation", kind: "design", group: "design", preset: "presentation", size: [1920, 1080], label: { en: "Presentation", ru: "Презентация" }, hint: { en: "16:9 slides", ru: "Слайды 16:9" }, words: "presentation slides deck pitch презентация слайды", tint: "var(--ui-tint-purple)" },
  { id: "social", kind: "design", group: "design", preset: "social", size: [1080, 1080], label: { en: "Social post", ru: "Пост" }, hint: { en: "Square, 1080 × 1080", ru: "Квадрат 1080 × 1080" }, words: "social post instagram square пост соцсети квадрат", tint: "var(--ui-tint-pink)" },
  { id: "story", kind: "design", group: "design", preset: "story", size: [1080, 1920], label: { en: "Story", ru: "Сторис" }, hint: { en: "Vertical, 9:16", ru: "Вертикаль 9:16" }, words: "story reels vertical сторис вертикаль", tint: "var(--ui-tint-yellow)" },
  { id: "mobile", kind: "design", group: "design", preset: "mobile", size: [390, 844], label: { en: "Mobile app", ru: "Приложение" }, hint: { en: "Phone screen", ru: "Экран телефона" }, words: "mobile app phone ios android приложение телефон экран", tint: "var(--ui-tint-teal)" },
  { id: "website", kind: "design", group: "design", preset: "website", size: [1440, 1024], label: { en: "Website", ru: "Сайт" }, hint: { en: "Desktop page", ru: "Страница сайта" }, words: "website web landing page desktop сайт лендинг страница", tint: "var(--ui-tint-indigo)" },
  { id: "a4", kind: "design", group: "design", preset: "a4", size: [595, 842], label: { en: "A4 print", ru: "A4 для печати" }, hint: { en: "Flyer, poster, letter", ru: "Флаер, постер, письмо" }, words: "a4 print flyer poster letter печать флаер постер", tint: "var(--ui-tint-stone)" },
  { id: "blank", kind: "design", group: "design", label: { en: "Custom size", ru: "Свой размер" }, hint: { en: "Draw any board", ru: "Любой холст" }, words: "custom size blank canvas empty свой размер пустой холст", tint: "var(--ui-tint-stone)" },
];

/** Starting points that already have content (Canva's templates), opened in one click too. */
export interface CreateTemplate {
  id: string;
  kind: "doc" | "design";
  /** Documents: a template key of components/notes/templates.ts; Design: of lib/design-templates.ts. */
  key: string;
  label: { en: string; ru: string };
  emoji: string;
}

export const CREATE_TEMPLATES: readonly CreateTemplate[] = [
  { id: "t-meeting", kind: "doc", key: "meeting", label: { en: "Meeting notes", ru: "Заметки встречи" }, emoji: "🗓️" },
  { id: "t-projects", kind: "doc", key: "projects", label: { en: "Project tracker", ru: "Трекер проектов" }, emoji: "🚀" },
  { id: "t-journal", kind: "doc", key: "journal", label: { en: "Journal", ru: "Дневник" }, emoji: "📔" },
  { id: "t-landing", kind: "design", key: "landing", label: { en: "Landing page", ru: "Лендинг" }, emoji: "🖥️" },
  { id: "t-mobile", kind: "design", key: "mobileApp", label: { en: "Mobile app screens", ru: "Экраны приложения" }, emoji: "📱" },
  { id: "t-uikit", kind: "design", key: "uiKit", label: { en: "UI kit", ru: "UI-кит" }, emoji: "🧱" },
];

/** For Cmd+K and others: the same list under the name they asked for. */
export const CREATE_KINDS = CREATE_ITEMS;

/**
 * The one-click link for an item. `forRef` ties what gets made to something
 * that exists ("issue:<id>", "project:<id>"): it shows up in its Related.
 */
export function createHref(item: Pick<CreateItem, "kind" | "preset">, ws: string, opts: { forRef?: string; name?: string } = {}): string {
  const q = new URLSearchParams({ ws, kind: item.kind });
  if (item.preset) q.set("preset", item.preset);
  if (opts.forRef) q.set("for", opts.forRef);
  if (opts.name) q.set("name", opts.name.slice(0, 120));
  return `/new?${q.toString()}`;
}

export function templateHref(t: CreateTemplate, ws: string, locale: string): string {
  return t.kind === "doc" ? `/docs?ws=${encodeURIComponent(ws)}#tpl=${t.key}/${locale === "ru" ? "ru" : "en"}` : `/api/design/template?ws=${encodeURIComponent(ws)}&key=${encodeURIComponent(t.key)}`;
}

/** Items whose name, hint or search words (and `extra`: the names in the interface's language) contain every word of the query. */
export function matchCreate<T extends { label: { en: string; ru: string }; words?: string; hint?: { en: string; ru: string } }>(list: readonly T[], query: string, extra?: (x: T) => string): T[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...list];
  return list.filter((x) => {
    const hay = `${x.label.en} ${x.label.ru} ${x.hint?.en ?? ""} ${x.hint?.ru ?? ""} ${x.words ?? ""} ${extra?.(x) ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** An item's name in the interface's language. */
export function itemLabel(item: Pick<CreateItem, "id" | "label">, locale: string): string {
  return locale === "ru" ? item.label.ru : ((locale === "en" ? undefined : msg("ds", locale, `item.${item.id}.label`)) ?? item.label.en);
}

/** An item's hint in the interface's language. */
export function itemHint(item: Pick<CreateItem, "id" | "hint">, locale: string): string {
  return locale === "ru" ? item.hint.ru : ((locale === "en" ? undefined : msg("ds", locale, `item.${item.id}.hint`)) ?? item.hint.en);
}

/** A starting template's name in the interface's language. */
export function templateLabel(t: Pick<CreateTemplate, "id" | "label">, locale: string): string {
  return locale === "ru" ? t.label.ru : ((locale === "en" ? undefined : msg("ds", locale, `tpl.${t.id}`)) ?? t.label.en);
}
