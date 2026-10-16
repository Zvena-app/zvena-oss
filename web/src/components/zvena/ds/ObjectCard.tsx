"use client";

// An object with a face (design system: ObjectCard): a design's frame, a
// doc's emoji, a project's color, an issue's status — on the soft ground of
// its kind — then its title and one line of metadata. Built on the
// ecosystem's Card (lib/eco/types.ts), so anything Related, search or My day
// already loads can be shown this way.

import type { CSSProperties, ReactNode } from "react";
import { CalendarDays, FileText, FolderKanban, ListTodo, Mail, PenTool, User } from "lucide-react";
import type { Card } from "@/lib/eco/types";
import { useI18n } from "@/lib/i18n-react";
import { StatusIcon } from "@/components/eco/CardView";
import { dt, type DsKey } from "./i18n";
import { relativeTime } from "./time";
import "./ds.css";

const TINT: Record<Card["kind"], string> = {
  note: "var(--ui-tint-blue)",
  issue: "var(--ui-tint-orange)",
  project: "var(--ui-tint-purple)",
  design: "var(--ui-tint-indigo)",
  user: "var(--ui-tint-stone)",
  event: "var(--ui-tint-teal)",
  mail: "var(--ui-tint-pink)",
};

const KIND: Record<Card["kind"], { key: DsKey; icon: ReactNode }> = {
  note: { key: "kindNote", icon: <FileText aria-hidden /> },
  issue: { key: "kindIssue", icon: <ListTodo aria-hidden /> },
  project: { key: "kindProject", icon: <FolderKanban aria-hidden /> },
  design: { key: "kindDesign", icon: <PenTool aria-hidden /> },
  user: { key: "kindUser", icon: <User aria-hidden /> },
  event: { key: "kindEvent", icon: <CalendarDays aria-hidden /> },
  mail: { key: "kindMail", icon: <Mail aria-hidden /> },
};

function Face({ card }: { card: Card }) {
  // A frame picture from /api/design/frame-image (same origin, already sized): no image optimizer in between.
  // eslint-disable-next-line @next/next/no-img-element
  if (card.kind === "design" && card.image) return <img src={card.image} alt="" loading="lazy" decoding="async" />;
  if (card.icon && (card.kind === "note" || card.kind === "project")) return <span className="ds-card-emoji">{card.icon}</span>;
  if (card.kind === "issue" && card.status) return <StatusIcon category={card.status.category} color={card.status.color} fraction={card.status.fraction} size={26} />;
  if (card.kind === "project") return <FolderKanban aria-hidden style={{ color: card.color }} />;
  return <>{KIND[card.kind].icon}</>;
}

export interface ObjectCardProps {
  card: Card;
  /** Replaces the default metadata line (when it was edited, the issue id, progress). */
  meta?: ReactNode;
  /** Instead of following card.url (a picker). */
  onPick?: (card: Card) => void;
  style?: CSSProperties;
}

export function ObjectCard({ card, meta, onPick, style }: ObjectCardProps) {
  const { locale } = useI18n();
  const kind = KIND[card.kind];
  const line = meta ?? (card.updatedAt ? dt(locale, "edited", { when: relativeTime(card.updatedAt, locale) }) : card.sub);
  const progress = card.kind === "project" && typeof card.progress === "number" ? Math.round(Math.max(0, Math.min(1, card.progress)) * 100) : null;
  return (
    <a
      className="ds-card"
      href={card.url}
      style={style}
      data-kind={card.kind}
      onClick={
        onPick
          ? (e) => {
              e.preventDefault();
              onPick(card);
            }
          : undefined
      }
    >
      <span className="ds-card-face" style={{ background: card.kind === "design" && card.image ? "var(--ui-bg-2)" : TINT[card.kind] }}>
        <Face card={card} />
        <span className="ds-card-kind">
          {kind.icon}
          {dt(locale, kind.key)}
        </span>
      </span>
      <span className="ds-card-body">
        <span className="ds-card-title">{card.title}</span>
        {/* Relative times move on between the server render and the browser's. */}
        {line && (
          <span className="ds-card-meta" suppressHydrationWarning>
            {line}
          </span>
        )}
        {progress !== null && (
          <span className="ds-card-progress" title={`${progress}%`}>
            <i style={{ width: `${progress}%` }} />
          </span>
        )}
      </span>
    </a>
  );
}

/** The grid ObjectCards sit in (2 columns on a phone). */
export function ObjectGrid({ children }: { children: ReactNode }) {
  return <div className="ds-cards">{children}</div>;
}
