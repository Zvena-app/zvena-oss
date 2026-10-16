// Status, priority and project icons of Projects.
//
// The status and priority glyphs are adapted from Circle by lndev-ui
// (https://github.com/ln-dev7/circle, MIT License, Copyright (c) 2025
// lndev-ui | Circle Template); see THIRD_PARTY_NOTICES.md.

import type { CSSProperties } from "react";

/**
 * Colors are stored as hex; the known ones are drawn through zvena's theme
 * tokens (--ui-status-*, --ui-label-*), so they follow light and dark.
 */
const TOKENS: Record<string, string> = {
  // workflow statuses
  "#95a2b3": "var(--ui-status-backlog, #95a2b3)",
  "#99a2b2": "var(--ui-status-todo, #99a2b2)",
  "#f2c94c": "var(--ui-status-progress, #f2c94c)",
  "#4cb782": "var(--ui-status-review, #4cb782)",
  "#5e6ad2": "var(--ui-status-done, #5e6ad2)",
  // the label palette
  "#787774": "var(--ui-label-gray, #787774)",
  "#9f6b53": "var(--ui-label-brown, #9f6b53)",
  "#d9730d": "var(--ui-label-orange, #d9730d)",
  "#cb912f": "var(--ui-label-yellow, #cb912f)",
  "#448361": "var(--ui-label-green, #448361)",
  "#337ea9": "var(--ui-label-blue, #337ea9)",
  "#9065b0": "var(--ui-label-purple, #9065b0)",
  "#c14c8a": "var(--ui-label-pink, #c14c8a)",
  "#d44c47": "var(--ui-label-red, #d44c47)",
  // colors of the first version, drawn with the nearest label color
  "#26b5ce": "var(--ui-label-blue, #26b5ce)",
  "#f2994a": "var(--ui-label-orange, #f2994a)",
  "#eb5757": "var(--ui-label-red, #eb5757)",
  "#bb87fc": "var(--ui-label-purple, #bb87fc)",
  "#e05fa8": "var(--ui-label-pink, #e05fa8)",
  "#0f783c": "var(--ui-label-green, #0f783c)",
  "#2c84db": "var(--ui-label-blue, #2c84db)",
  "#8a5a44": "var(--ui-label-brown, #8a5a44)",
};

export function uiColor(hex: string | null | undefined): string {
  if (!hex) return "var(--ui-label-gray, #787774)";
  return TOKENS[hex.toLowerCase()] ?? hex;
}
import type { Health, Priority, ProjectState, StatusCategory } from "@/lib/projects/types";

const GEAR =
  "M13.9408 7.91426L11.9576 7.65557C11.9855 7.4419 12 7.22314 12 7C12 6.77686 11.9855 6.5581 11.9576 6.34443L13.9408 6.08573C13.9799 6.38496 14 6.69013 14 7C14 7.30987 13.9799 7.61504 13.9408 7.91426ZM13.4688 4.32049C13.2328 3.7514 12.9239 3.22019 12.5538 2.73851L10.968 3.95716C11.2328 4.30185 11.4533 4.68119 11.6214 5.08659L13.4688 4.32049ZM11.2615 1.4462L10.0428 3.03204C9.69815 2.76716 9.31881 2.54673 8.91341 2.37862L9.67951 0.531163C10.2486 0.767153 10.7798 1.07605 11.2615 1.4462ZM7.91426 0.0591659L7.65557 2.04237C7.4419 2.01449 7.22314 2 7 2C6.77686 2 6.5581 2.01449 6.34443 2.04237L6.08574 0.059166C6.38496 0.0201343 6.69013 0 7 0C7.30987 0 7.61504 0.0201343 7.91426 0.0591659ZM4.32049 0.531164L5.08659 2.37862C4.68119 2.54673 4.30185 2.76716 3.95716 3.03204L2.73851 1.4462C3.22019 1.07605 3.7514 0.767153 4.32049 0.531164ZM1.4462 2.73851L3.03204 3.95716C2.76716 4.30185 2.54673 4.68119 2.37862 5.08659L0.531164 4.32049C0.767153 3.7514 1.07605 3.22019 1.4462 2.73851ZM0.0591659 6.08574C0.0201343 6.38496 0 6.69013 0 7C0 7.30987 0.0201343 7.61504 0.059166 7.91426L2.04237 7.65557C2.01449 7.4419 2 7.22314 2 7C2 6.77686 2.01449 6.5581 2.04237 6.34443L0.0591659 6.08574ZM0.531164 9.67951L2.37862 8.91341C2.54673 9.31881 2.76716 9.69815 3.03204 10.0428L1.4462 11.2615C1.07605 10.7798 0.767153 10.2486 0.531164 9.67951ZM2.73851 12.5538L3.95716 10.968C4.30185 11.2328 4.68119 11.4533 5.08659 11.6214L4.32049 13.4688C3.7514 13.2328 3.22019 12.9239 2.73851 12.5538ZM6.08574 13.9408L6.34443 11.9576C6.5581 11.9855 6.77686 12 7 12C7.22314 12 7.4419 11.9855 7.65557 11.9576L7.91427 13.9408C7.61504 13.9799 7.30987 14 7 14C6.69013 14 6.38496 13.9799 6.08574 13.9408ZM9.67951 13.4688L8.91341 11.6214C9.31881 11.4533 9.69815 11.2328 10.0428 10.968L11.2615 12.5538C10.7798 12.9239 10.2486 13.2328 9.67951 13.4688ZM12.5538 11.2615L10.968 10.0428C11.2328 9.69815 11.4533 9.31881 11.6214 8.91341L13.4688 9.67951C13.2328 10.2486 12.924 10.7798 12.5538 11.2615Z";
const CHECK =
  "M7 0C3.13401 0 0 3.13401 0 7C0 10.866 3.13401 14 7 14C10.866 14 14 10.866 14 7C14 3.13401 10.866 0 7 0ZM11.101 5.10104C11.433 4.76909 11.433 4.23091 11.101 3.89896C10.7691 3.56701 10.2309 3.56701 9.89896 3.89896L5.5 8.29792L4.10104 6.89896C3.7691 6.56701 3.2309 6.56701 2.89896 6.89896C2.56701 7.2309 2.56701 7.7691 2.89896 8.10104L4.89896 10.101C5.2309 10.433 5.7691 10.433 6.10104 10.101L11.101 5.10104Z";
const CROSS =
  "M7 14C10.866 14 14 10.866 14 7C14 3.13401 10.866 0 7 0C3.13401 0 0 3.13401 0 7C0 10.866 3.13401 14 7 14ZM5.03033 3.96967C4.73744 3.67678 4.26256 3.67678 3.96967 3.96967C3.67678 4.26256 3.67678 4.73744 3.96967 5.03033L5.93934 7L3.96967 8.96967C3.67678 9.26256 3.67678 9.73744 3.96967 10.0303C4.26256 10.3232 4.73744 10.3232 5.03033 10.0303L7 8.06066L8.96967 10.0303C9.26256 10.3232 9.73744 10.3232 10.0303 10.0303C10.3232 9.73744 10.3232 9.26256 10.0303 8.96967L8.06066 7L10.0303 5.03033C10.3232 4.73744 10.3232 4.26256 10.0303 3.96967C9.73744 3.67678 9.26256 3.67678 8.96967 3.96967L7 5.93934L5.03033 3.96967Z";

export function StatusIcon({ category, color, fraction = 0.5, size = 14, title }: { category: StatusCategory; color: string; fraction?: number; size?: number; title?: string }) {
  const common = { width: size, height: size, viewBox: "0 0 14 14", ...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true }), className: "pj-status-icon", style: { color: color === "currentColor" ? undefined : uiColor(color) } } as const;
  if (category === "backlog")
    return (
      <svg {...common} fill="currentColor">
        {title && <title>{title}</title>}
        <path d={GEAR} />
      </svg>
    );
  if (category === "completed")
    return (
      <svg {...common} fill="currentColor">
        {title && <title>{title}</title>}
        <path fillRule="evenodd" clipRule="evenodd" d={CHECK} />
      </svg>
    );
  if (category === "canceled")
    return (
      <svg {...common} fill="currentColor">
        {title && <title>{title}</title>}
        <path fillRule="evenodd" clipRule="evenodd" d={CROSS} />
      </svg>
    );
  const f = category === "unstarted" ? 0 : Math.max(0.01, Math.min(fraction, 0.9999));
  const angle = f * 2 * Math.PI;
  const x = 3.5 + 3.5 * Math.sin(angle);
  const y = 3.5 - 3.5 * Math.cos(angle);
  return (
    <svg {...common} fill="none">
      {title && <title>{title}</title>}
      <rect x="1" y="1" width="12" height="12" rx="6" stroke="currentColor" strokeWidth="1.5" />
      {f > 0 && <path fill="currentColor" d={`M 3.5,3.5 L3.5,0 A3.5,3.5 0 ${f > 0.5 ? 1 : 0},1 ${x.toFixed(4)},${y.toFixed(4)} z`} transform="translate(3.5,3.5)" />}
    </svg>
  );
}

export function PriorityIcon({ priority, size = 16, title, style }: { priority: Priority; size?: number; title?: string; style?: CSSProperties }) {
  const common = { width: size, height: size, viewBox: "0 0 16 16", fill: "currentColor", ...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true }), style, className: `pj-prio-icon pj-prio-${priority}` } as const;
  if (priority === 0)
    return (
      <svg {...common}>
        {title && <title>{title}</title>}
        <rect x="1.5" y="7.25" width="3" height="1.5" rx="0.5" opacity="0.9" />
        <rect x="6.5" y="7.25" width="3" height="1.5" rx="0.5" opacity="0.9" />
        <rect x="11.5" y="7.25" width="3" height="1.5" rx="0.5" opacity="0.9" />
      </svg>
    );
  if (priority === 1)
    return (
      <svg {...common}>
        {title && <title>{title}</title>}
        <path d="M3 1C1.91067 1 1 1.91067 1 3V13C1 14.0893 1.91067 15 3 15H13C14.0893 15 15 14.0893 15 13V3C15 1.91067 14.0893 1 13 1H3ZM7 4L9 4L8.75391 8.99836H7.25L7 4ZM9 11C9 11.5523 8.55228 12 8 12C7.44772 12 7 11.5523 7 11C7 10.4477 7.44772 10 8 10C8.55228 10 9 10.4477 9 11Z" />
      </svg>
    );
  const bars = { 2: [1, 1, 1], 3: [1, 1, 0.4], 4: [1, 0.4, 0.4] }[priority];
  return (
    <svg {...common}>
      {title && <title>{title}</title>}
      <rect x="1.5" y="8" width="3" height="6" rx="1" fillOpacity={bars[0]} />
      <rect x="6.5" y="5" width="3" height="9" rx="1" fillOpacity={bars[1]} />
      <rect x="11.5" y="2" width="3" height="12" rx="1" fillOpacity={bars[2]} />
    </svg>
  );
}

const STATE_COLOR: Record<ProjectState, string> = {
  backlog: "#95a2b3",
  planned: "#8a8f98",
  started: "#f2c94c",
  paused: "#26b5ce",
  completed: "#5e6ad2",
  canceled: "#95a2b3",
};

export function ProjectStateIcon({ state, size = 14, title }: { state: ProjectState; size?: number; title?: string }) {
  const color = STATE_COLOR[state];
  if (state === "paused")
    // Paused is not "in progress": a circle with the pause bars (Linear's paused project).
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" fill="none" className="pj-status-icon" style={{ color: uiColor(color) }} {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true })}>
        {title && <title>{title}</title>}
        <rect x="1" y="1" width="12" height="12" rx="6" stroke="currentColor" strokeWidth="1.5" />
        <rect x="4.75" y="4.25" width="1.5" height="5.5" rx="0.5" fill="currentColor" />
        <rect x="7.75" y="4.25" width="1.5" height="5.5" rx="0.5" fill="currentColor" />
      </svg>
    );
  const cat: StatusCategory = state === "backlog" ? "backlog" : state === "planned" ? "unstarted" : state === "completed" ? "completed" : state === "canceled" ? "canceled" : "started";
  return <StatusIcon category={cat} color={color} fraction={0.5} size={size} title={title} />;
}

export const HEALTH_COLOR: Record<Health, string> = { on_track: "#4cb782", at_risk: "#f2994a", off_track: "#eb5757" };

export function HealthDot({ health, size = 8 }: { health: Health | null; size?: number }) {
  return <span className="pj-health-dot" style={{ width: size, height: size, background: health ? HEALTH_COLOR[health] : "var(--zv-border-2)" }} aria-hidden="true" />;
}

/** A small rounded square with the project's / team's emoji or first letter. */
export function Glyph({ icon, color, text, size = 18 }: { icon: string | null; color: string; text: string; size?: number }) {
  return (
    <span className="pj-glyph" style={{ width: size, height: size, fontSize: Math.round(size * 0.62), background: icon ? "transparent" : uiColor(color) }} aria-hidden="true">
      {icon || (text.trim().charAt(0) || "·").toUpperCase()}
    </span>
  );
}

export function ProjectGlyph({ icon, color, size = 16 }: { icon: string | null; color: string; size?: number }) {
  if (icon) return <span style={{ fontSize: size * 0.85, lineHeight: 1, width: size, textAlign: "center", display: "inline-block" }} aria-hidden="true">{icon}</span>;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" className="pj-project-glyph" style={{ color: uiColor(color) }}>
      <path d="M8 1.5 14 4.75v6.5L8 14.5 2 11.25v-6.5L8 1.5Z" fill="currentColor" fillOpacity="0.22" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M2.4 4.9 8 8l5.6-3.1M8 8v6.2" stroke="currentColor" strokeWidth="1.2" fill="none" />
    </svg>
  );
}

export function CycleGlyph({ size = 16, progress = 0 }: { size?: number; progress?: number }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" className="pj-cycle-glyph">
      <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.6" />
      <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray={`${c * progress} ${c}`} transform="rotate(-90 8 8)" strokeLinecap="round" />
    </svg>
  );
}
