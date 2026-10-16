"use client";

// Page icons: an emoji, one of Notion's monochrome icons in a colour
// ("icon:<name>:<color>"), or an uploaded image ("/api/notes/file/…").

import type { ReactNode } from "react";
import { iconText } from "@/lib/notes/model";
import { iconsPart } from "./lazy";

export const ICON_COLORS = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;

/** A page / callout / button icon rendered at the surrounding font size (like an emoji). */
export function NoteIcon({ icon, fallback = null, className }: { icon: string | undefined | null; fallback?: ReactNode; className?: string }): ReactNode {
  if (!icon) return fallback;
  if (icon.startsWith("icon:")) {
    const [, name, color] = icon.split(":");
    return <LucideNoteIcon name={name} color={color} className={className} fallback={fallback} />;
  }
  if (icon.startsWith("/api/notes/file/")) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={className ? `nt-imgicon ${className}` : "nt-imgicon"} src={icon} alt="" />;
  }
  return iconText(icon) || fallback;
}

/** An "icon:" icon: its set loads on first use; until then an empty box of the same size holds the place. */
function LucideNoteIcon({ name, color, className, fallback }: { name: string; color?: string; className?: string; fallback: ReactNode }): ReactNode {
  const set = iconsPart.use();
  const cls = className ? `nt-licon ${className}` : "nt-licon";
  if (!set) return <span className={`${cls} nt-licon-wait`} aria-hidden="true" />;
  const C = set.ICONS[name];
  if (!C) return fallback;
  return <C className={cls} style={{ color: color && color !== "default" ? `var(--nt-c-${color})` : undefined }} strokeWidth={2} aria-hidden="true" />;
}
