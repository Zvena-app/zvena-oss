"use client";

// App-wide interface state of Projects: the create-issue dialog, the command
// palette, the shortcuts help, and what the open screen has selected or
// focused (so the palette and shortcuts act on it).

import type { Issue } from "@/lib/projects/types";
import { Store } from "./data";

export interface CreateDefaults {
  teamId?: string;
  statusId?: string;
  priority?: number;
  assigneeId?: string | null;
  projectId?: string | null;
  cycleId?: string | null;
  parentId?: string | null;
  labelIds?: string[];
  title?: string;
  description?: string;
  dueDate?: string | null;
  estimate?: number | null;
  milestoneId?: string | null;
  /** A ref of zvena's link registry (note:…, project:…, design:…) the new issue is linked to. */
  linkFor?: string;
}

export interface UiState {
  create: CreateDefaults | null;
  palette: { issues?: Issue[] } | null;
  help: boolean;
  /** Issues the open screen has selected (or the focused one). */
  target: Issue[];
  /** The "overdue and stale" report (opened from the rail). */
  stale: boolean;
}

export const ui = new Store<UiState>({ create: null, palette: null, help: false, target: [], stale: false });

export function openCreate(d: CreateDefaults = {}): void {
  ui.update((s) => ({ ...s, create: d }));
}

export function closeCreate(): void {
  ui.update((s) => ({ ...s, create: null }));
}

export function openPalette(issues?: Issue[]): void {
  ui.update((s) => ({ ...s, palette: { issues } }));
}

export function setTarget(issues: Issue[]): void {
  const cur = ui.get().target;
  if (cur.length === issues.length && cur.every((x, i) => x === issues[i])) return;
  ui.update((s) => ({ ...s, target: issues }));
}

/** True when typing in a field (single-key shortcuts must not fire). */
export function typing(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

export function remember<T>(key: string, value?: T): T | null {
  try {
    if (value !== undefined) {
      localStorage.setItem(`pj:${key}`, JSON.stringify(value));
      return value;
    }
    const raw = localStorage.getItem(`pj:${key}`);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
