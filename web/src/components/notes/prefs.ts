"use client";

// Per-device Notes preferences kept with the theme in localStorage
// ("zvena-settings"): Notion's "Start week on Monday" and "Open on start".

import { useSyncExternalStore } from "react";
import { mondayFirstIn } from "@/i18n/locales";

const KEY = "zvena-settings";
const EVENT = "nt-prefs";

function read(): Record<string, unknown> {
  try {
    return (JSON.parse(localStorage.getItem(KEY) || "null") as Record<string, unknown> | null) ?? {};
  } catch {
    return {};
  }
}

/** "mon" / "sun", or "" for the language's default (its region's calendar). */
function weekStartSetting(): string {
  const v = read().weekStart;
  return v === "mon" || v === "sun" ? v : "";
}

export function setWeekStart(v: "mon" | "sun"): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...read(), weekStart: v }));
  } catch {
    // Private mode: the choice lasts until reload.
  }
  window.dispatchEvent(new Event(EVENT));
}

/** Notion's "Open on start": the last visited page (default), Home, or the sidebar's first page. */
export type OpenOnStart = "last" | "home" | "top";

export function openOnStart(): OpenOnStart {
  const v = read().openOnStart;
  return v === "home" || v === "top" ? v : "last";
}

export function setOpenOnStart(v: OpenOnStart): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...read(), openOnStart: v }));
  } catch {
    // Private mode: the choice lasts until reload.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function useOpenOnStart(): OpenOnStart {
  return useSyncExternalStore(subscribe, openOnStart, () => "last");
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

/** Whether weeks start on Monday (calendars, date pickers). */
export function useMondayFirst(locale: string): boolean {
  const v = useSyncExternalStore(subscribe, weekStartSetting, () => "");
  return v ? v === "mon" : mondayFirstIn(locale);
}

// Theme (shared with the rest of zvena: light, dark or the system's).

export type Theme = "light" | "dark" | "system";

export function readTheme(): Theme {
  try {
    const s = JSON.parse(localStorage.getItem("zvena-settings") || "null") as { theme?: Theme } | null;
    return s?.theme ?? "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme): void {
  try {
    const s = (JSON.parse(localStorage.getItem("zvena-settings") || "null") as Record<string, unknown> | null) ?? {};
    localStorage.setItem("zvena-settings", JSON.stringify({ ...s, theme }));
  } catch {
    // ignore
  }
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  window.dispatchEvent(new Event("nt-theme"));
}
