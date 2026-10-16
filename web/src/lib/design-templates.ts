// Design templates: .penpot files shipped with the web app (templates/design/)
// and imported into a workspace's Design team on "Use" (app/api/design/template).
// design/tools/templates builds them from HTML (see its README). Each one is
// <key>.penpot in English and, optionally, <key>.ru.penpot in Russian.

import { existsSync } from "node:fs";
import { join } from "node:path";

export interface DesignTemplate {
  key: string;
  icon: string;
  file: string;
  name: { ru: string; en: string };
  description: { ru: string; en: string };
}

export const DESIGN_TEMPLATES: DesignTemplate[] = [
  {
    key: "landing",
    icon: "🖥️",
    file: "landing.penpot",
    name: { ru: "Лендинг", en: "Landing page" },
    description: { ru: "Первый экран, преимущества, тарифы, отзывы и подвал — десктоп и телефон.", en: "Hero, features, pricing, testimonials and footer — desktop and phone." },
  },
  {
    key: "mobileApp",
    icon: "📱",
    file: "mobile-app.penpot",
    name: { ru: "Мобильное приложение", en: "Mobile app" },
    description: { ru: "Вход, лента, карточка, профиль и настройки с нижней навигацией.", en: "Sign-in, feed, detail, profile and settings with a tab bar." },
  },
  {
    key: "uiKit",
    icon: "🧱",
    file: "ui-kit.penpot",
    name: { ru: "UI-кит", en: "UI kit" },
    description: { ru: "Цвета, типографика, кнопки, поля, переключатели, карточки и уведомления.", en: "Colors, type, buttons, inputs, toggles, cards and alerts." },
  },
];

const DIR = () => join(process.cwd(), "templates/design");

/** The template's file for the interface language (English unless Russian is chosen and exists), or null. */
export function templateFile(t: DesignTemplate, locale: "en" | "ru"): string | null {
  const en = join(DIR(), t.file);
  const ru = join(DIR(), t.file.replace(/\.penpot$/, ".ru.penpot"));
  const order = locale === "ru" ? [ru, en] : [en, ru];
  return order.find((f) => existsSync(f)) ?? null;
}
