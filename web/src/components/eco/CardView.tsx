"use client";

// How any object looks wherever the ecosystem shows it: one component for an
// issue, a page, a project and a design frame, in three sizes.
//
//   row     a line in "Related", search results, Home
//   block   a live block inside a document (an issue with its status menu)
//   chip    inline, a pill
//
// Colors come from the surface it sits on (eco.css maps Projects', Documents'
// and the shell's tokens), so the same card fits everywhere.

import type { MouseEvent, ReactNode } from "react";
import { CalendarDays, FileText, FolderKanban, Mail, PenTool, CircleDashed } from "lucide-react";
import type { Card, StatusCategory } from "@/lib/eco/types";
import { useEt } from "./i18n";
import { useI18n } from "@/lib/i18n-react";
import { intlTag, type Locale } from "@/i18n/locales";
import type { CardState } from "./client";
import { StatusIcon as ProjectsStatusIcon } from "@/components/projects/icons";
import { StatusButton } from "./StatusMenu";

/** Linear's status icon (Projects' own): dashed backlog, empty todo, a partly filled circle in progress, done, canceled. */
export function StatusIcon({ category, color, fraction, size = 14 }: { category: StatusCategory; color?: string; fraction?: number; size?: number }) {
  return <ProjectsStatusIcon category={category} color={color || "currentColor"} fraction={fraction ?? 0.5} size={size} />;
}

export function KindIcon({ card, size = 16 }: { card: Card; size?: number }) {
  if (card.kind === "issue") return card.status ? <StatusIcon category={card.status.category} color={card.status.color} fraction={card.status.fraction} size={size - 2} /> : <CircleDashed size={size - 2} />;
  if (card.kind === "note") return card.icon ? <span className="eco-emoji">{card.icon}</span> : <FileText size={size} />;
  if (card.kind === "project")
    return card.icon ? (
      <span className="eco-emoji">{card.icon}</span>
    ) : (
      <FolderKanban size={size} style={{ color: card.color }} />
    );
  if (card.kind === "user") return <Avatar name={card.title} />;
  if (card.kind === "event") return <CalendarDays size={size} style={{ color: card.color }} />;
  if (card.kind === "mail") return <Mail size={size} />;
  return <PenTool size={size} />;
}

function Avatar({ name }: { name: string }) {
  const initial = (name.trim().charAt(0) || "?").toUpperCase();
  return (
    <span className="eco-avatar" title={name} aria-label={name}>
      {initial}
    </span>
  );
}

function dueText(due: string, locale: Locale): { text: string; late: boolean } {
  const today = new Date();
  const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const d = new Date(`${due}T00:00:00`);
  const text = d.toLocaleDateString(intlTag(locale), { month: "short", day: "numeric" });
  return { text, late: due < ymd };
}

function Progress({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <span className="eco-progress" title={`${pct}%`}>
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}

export interface CardViewProps {
  card: CardState;
  variant?: "row" | "block" | "chip";
  /** Issues (block variant): the workspace their status menu changes them in. Absent: the status only shows. */
  statusWs?: string;
  busy?: boolean;
  /** Shown at the end of the row (a remove button, the way it is linked). */
  right?: ReactNode;
  /** Instead of following the link (a picker). */
  onPick?: (card: Card) => void;
  active?: boolean;
  /** Block: shown before the status (Home puts the issue's priority there). */
  lead?: ReactNode;
}

export function CardView({ card, variant = "row", statusWs, busy, right, onPick, active, lead }: CardViewProps) {
  const et = useEt();
  const { locale } = useI18n();
  if (card === undefined) {
    return (
      <div className={`eco-card eco-${variant} eco-loading`} aria-busy="true">
        <span className="eco-skel" />
      </div>
    );
  }
  if (card === null) {
    return (
      <div className={`eco-card eco-${variant} eco-missing`} contentEditable={false}>
        <CircleDashed size={14} />
        <span>{et("unavailable")}</span>
        {right}
      </div>
    );
  }
  const done = card.status?.category === "completed";
  const canceled = card.status?.category === "canceled";
  const click = (e: MouseEvent) => {
    if (!onPick) return;
    e.preventDefault();
    onPick(card);
  };
  const meta = (
    <>
      {card.kind === "project" && typeof card.progress === "number" && <Progress value={card.progress} />}
      {card.kind === "issue" && card.due && !done && !canceled && (() => {
        const d = dueText(card.due, locale);
        // The server's and the browser's date names can differ (ICU versions: Hindi "अक्टू॰" / "अक्तू॰"); the browser's wins without a hydration error.
        return (
          <span className={`eco-due${d.late ? " eco-late" : ""}`} title={d.late ? et("overdue") : et("due")} suppressHydrationWarning>
            {d.text}
          </span>
        );
      })()}
      {card.kind === "issue" && card.assignee?.name && <Avatar name={card.assignee.name} />}
    </>
  );
  if (variant === "chip") {
    return (
      <a className="eco-card eco-chip" href={card.url} onClick={click} data-kind={card.kind} data-done={done || canceled || undefined}>
        <KindIcon card={card} size={14} />
        {card.kind === "issue" && card.sub && <span className="eco-ident">{card.sub}</span>}
        <span className="eco-title">{card.title}</span>
      </a>
    );
  }
  if (variant === "block") {
    return (
      <div className="eco-card eco-block" data-kind={card.kind} data-done={done || canceled || undefined} contentEditable={false}>
        {lead}
        {card.kind === "issue" ? (
          <StatusButton ws={statusWs} card={card} disabled={busy} />
        ) : (
          <span className="eco-kind">
            <KindIcon card={card} />
          </span>
        )}
        <a className="eco-main" href={card.url} onClick={click} title={et("issueOpen")}>
          {card.sub && card.kind === "issue" && <span className="eco-ident">{card.sub}</span>}
          <span className="eco-title">{card.title}</span>
        </a>
        <span className="eco-meta">
          {card.status && card.kind === "issue" && <span className="eco-status-name">{card.status.name}</span>}
          {meta}
        </span>
        {right}
      </div>
    );
  }
  return (
    <a className="eco-card eco-row" href={card.url} onClick={click} data-kind={card.kind} data-done={done || canceled || undefined} data-active={active || undefined}>
      {card.image ? (
        // eslint-disable-next-line @next/next/no-img-element -- a card's own thumbnail from any site (or a file of this workspace); next/image would need every host allow-listed
        <img className="eco-thumb" src={card.image} alt="" loading="lazy" />
      ) : (
        <span className="eco-kind">
          <KindIcon card={card} />
        </span>
      )}
      {card.kind === "issue" && card.sub && <span className="eco-ident">{card.sub}</span>}
      <span className="eco-text">
        <span className="eco-title">{card.title || et("untitled")}</span>
        {card.kind !== "issue" && card.sub && <span className="eco-sub">{card.sub}</span>}
      </span>
      <span className="eco-meta">{meta}</span>
      {right}
    </a>
  );
}
