"use client";

// How issues are drawn: list rows, board cards and the calendar, with
// inline property editing, multi-selection, context menus and drag and drop
// (between groups and to a place in manual order). The screen around them
// (IssuesScreen) owns the data and the keyboard.

import { memo, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { ListRow } from "@/components/zvena/ds";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, GitBranch, MessageSquare, OctagonAlert, Paperclip, Plus, Ban, Gauge, MoreHorizontal } from "lucide-react";
import { estimateLabel, type DisplayProp, type Issue, type IssueDisplay } from "@/lib/projects/types";
import { useLookups, useStore, type Lookups } from "./data";
import { beginDrag, dragState, touchedLast, type DropTarget } from "./drag";
import type { GroupInfo } from "./groups";
import { CycleGlyph, PriorityIcon, ProjectGlyph, StatusIcon, uiColor } from "./icons";
import { useT, type PT } from "./i18n";
import { intlOf, weekdayNames, weekStartIn } from "@/i18n/locales";
import { dueWord, personName, PropButton, PropPill } from "./pickers";
import { href } from "./router";
import { Avatar, UnassignedIcon, useFormat, type Anchor } from "./ui";

export interface ViewGroup {
  info: GroupInfo;
  count: number;
  items: Issue[];
  cursor: string | null;
}

export interface ListHandlers {
  selected: Set<string>;
  focused: string | null;
  canEdit: boolean;
  onOpen: (issue: Issue, e: MouseEvent) => void;
  onSelect: (issue: Issue, e: MouseEvent) => void;
  onFocus: (issue: Issue) => void;
  onContext: (issue: Issue, e: MouseEvent) => void;
  /** The "…" quick action of a row (or a long press on touch): the issue's menu there. */
  onMore: (issue: Issue, anchor: Anchor) => void;
  onCreate: (group: GroupInfo) => void;
  onLoadMore: (group: ViewGroup) => void;
  /** Dropped `issueId` into `group`, between `before` (above) and `after` (below). */
  onDrop: (issueId: string, group: GroupInfo, before: string | null, after: string | null) => void;
}

const has = (d: IssueDisplay, p: DisplayProp) => d.props.includes(p);

/** The right-hand properties of a row (and the footer of a card), as Pills that edit in one click. */
function Meta({ issue, d, L, t, compact, canEdit }: { issue: Issue; d: IssueDisplay; L: Lookups; t: PT; compact?: boolean; canEdit: boolean }) {
  const f = useFormat();
  const st = L.status.get(issue.statusId);
  const closed = st?.category === "completed" || st?.category === "canceled";
  const project = issue.projectId ? L.project.get(issue.projectId) : null;
  const cycle = issue.cycleId ? L.cycle.get(issue.cycleId) : null;
  const team = L.team.get(issue.teamId);
  const milestone = project && issue.milestoneId ? project.milestones.find((m) => m.id === issue.milestoneId) : null;
  const out: ReactNode[] = [];
  if (has(d, "links")) {
    if (issue.blockedBy > 0)
      out.push(
        <span key="blk" className="pj-meta-ico pj-blocked" title={`${t("rel.blocked_by")}: ${issue.blockedBy}`}>
          <Ban size={13} />
        </span>
      );
    if (issue.blocking > 0)
      out.push(
        <span key="bkg" className="pj-meta-ico pj-blocking" title={`${t("rel.blocks")}: ${issue.blocking}`}>
          <OctagonAlert size={13} />
        </span>
      );
    if (issue.subIssues.total > 0)
      out.push(
        <span key="sub" className="pj-meta-txt" title={t("i.subIssues")}>
          <GitBranch size={12} />
          {issue.subIssues.done}/{issue.subIssues.total}
        </span>
      );
    if (!compact && issue.comments > 0)
      out.push(
        <span key="com" className="pj-meta-txt" title={t("i.activity")}>
          <MessageSquare size={12} />
          {issue.comments}
        </span>
      );
    if (!compact && issue.attachments > 0)
      out.push(
        <span key="att" className="pj-meta-txt" title={t("i.attachments")}>
          <Paperclip size={12} />
          {issue.attachments}
        </span>
      );
  }
  if (has(d, "labels")) {
    const labels = issue.labelIds.map((id) => L.label.get(id)).filter((l): l is NonNullable<typeof l> => Boolean(l));
    const max = compact ? 2 : 3;
    for (const l of labels.slice(0, max))
      out.push(
        <PropPill key={`l${l.id}`} kind="labels" issue={issue} canEdit={canEdit} dot={uiColor(l.color)} title={t("f.labels")}>
          {l.name}
        </PropPill>
      );
    if (labels.length > max)
      out.push(
        <PropPill key="lmore" kind="labels" issue={issue} canEdit={canEdit} title={labels.slice(max).map((l) => l.name).join(", ")}>
          +{labels.length - max}
        </PropPill>
      );
  }
  if (has(d, "project") && project)
    out.push(
      <PropPill key="prj" kind="project" issue={issue} canEdit={canEdit} icon={<ProjectGlyph icon={project.icon} color={project.color} size={13} />} title={t("f.project")}>
        {project.name}
      </PropPill>
    );
  if (has(d, "milestone") && milestone)
    out.push(
      <PropPill key="ms" kind="milestone" issue={issue} canEdit={canEdit} icon={<span aria-hidden>◆</span>} title={t("p.milestone")}>
        {milestone.name}
      </PropPill>
    );
  if (has(d, "cycle") && cycle)
    out.push(
      <PropPill key="cyc" kind="cycle" issue={issue} canEdit={canEdit} icon={<CycleGlyph size={13} progress={cycle.progress.total ? cycle.progress.completed / cycle.progress.total : 0} />} title={t("f.cycle")}>
        {cycle.name || t("cy.name", { n: cycle.number })}
      </PropPill>
    );
  if (has(d, "due") && issue.dueDate) {
    // An overdue date is said in words and in the danger color (never just a colored row).
    const late = !closed && issue.dueDate < L.b.today;
    out.push(
      <PropPill key="due" kind="due" issue={issue} canEdit={canEdit} icon={<CalendarDays size={12} />} tone={late ? "late" : "default"} title={`${t("f.due")}: ${issue.dueDate}`}>
        {dueWord(issue.dueDate, L.b.today, t, f.day)}
      </PropPill>
    );
  }
  if (has(d, "estimate") && issue.estimate !== null && team && team.estimates !== "none")
    out.push(
      <PropPill key="est" kind="estimate" issue={issue} canEdit={canEdit} icon={<Gauge size={12} />} title={t("p.estimate")}>
        {estimateLabel(team.estimates, issue.estimate)}
      </PropPill>
    );
  if (has(d, "created") && !compact)
    out.push(
      <span key="cr" className="pj-meta-date" title={f.dateTime(issue.createdAt)}>
        {f.day(issue.createdAt)}
      </span>
    );
  if (has(d, "updated") && !compact)
    out.push(
      <span key="up" className="pj-meta-date" title={f.dateTime(issue.updatedAt)}>
        {f.ago(issue.updatedAt)}
      </span>
    );
  return <>{out}</>;
}

function AssigneeButton({ issue, L, t, canEdit, size = 20 }: { issue: Issue; L: Lookups; t: PT; canEdit: boolean; size?: number }) {
  const p = issue.assigneeId ? L.person.get(issue.assigneeId) : null;
  const content = issue.assigneeId ? <Avatar name={p?.name ?? "?"} id={issue.assigneeId} size={size} src={p?.avatar} faded={!p?.role} /> : <UnassignedIcon size={size} />;
  const label = `${t("f.assignee")}: ${personName(L, issue.assigneeId, t)}`;
  if (!canEdit)
    return (
      <span className="pj-prop-btn" title={label}>
        {content}
      </span>
    );
  return (
    <PropButton kind="assignee" issue={issue} label={label} className="pj-assignee-btn">
      {content}
    </PropButton>
  );
}

function StatusBtn({ issue, L, t, canEdit }: { issue: Issue; L: Lookups; t: PT; canEdit: boolean }) {
  const s = L.status.get(issue.statusId);
  const icon = s ? <StatusIcon category={s.category} color={s.color} fraction={L.fraction(s.id)} /> : null;
  const label = `${t("f.status")}: ${s?.name ?? ""}`;
  return canEdit ? (
    <PropButton kind="status" issue={issue} label={label}>
      {icon}
    </PropButton>
  ) : (
    <span className="pj-prop-btn" title={label}>
      {icon}
    </span>
  );
}

function PriorityBtn({ issue, t, canEdit }: { issue: Issue; t: PT; canEdit: boolean }) {
  const label = `${t("f.priority")}: ${t(`prio.${issue.priority}`)}`;
  const icon = <PriorityIcon priority={issue.priority} />;
  return canEdit ? (
    <PropButton kind="priority" issue={issue} label={label}>
      {icon}
    </PropButton>
  ) : (
    <span className="pj-prop-btn" title={label}>
      {icon}
    </span>
  );
}

// --- Drag and drop (drag.ts) -----------------------------------------------------

type DragStart = (e: PointerEvent<HTMLElement>, issue: Issue) => void;

function useDropInto(groups: ViewGroup[], h: ListHandlers, manual: boolean, itemSelector: string): DragStart {
  return (e, issue) => {
    if (!h.canEdit && e.pointerType !== "touch") return;
    beginDrag(e, issue.id, {
      itemSelector,
      drag: h.canEdit,
      // Touch: a long press without moving opens the issue's menu (Linear's iOS app).
      onLongPress: (x, y) => h.onMore(issue, { x, y }),
      onDrop: (id: string, target: DropTarget) => {
        const g = groups.find((x) => x.info.key === target.zone);
        if (g) h.onDrop(id, g.info, manual ? target.before : null, manual ? target.after : null);
      },
    });
  };
}

/** Where the drop line goes in a zone: before the item `after`, or at the end. */
function useDropLine(zone: string): { active: boolean; before: (id: string) => boolean; atEnd: boolean } {
  const ds = useStore(dragState);
  const t = ds.target && ds.target.zone === zone ? ds.target : null;
  return { active: Boolean(t), before: (id) => Boolean(t && t.after === id), atEnd: Boolean(t && t.after === null) };
}

// --- List ----------------------------------------------------------------------

export const IssueRow = memo(function IssueRow({ issue, d, h }: { issue: Issue; d: IssueDisplay; h: ListHandlers }) {
  const L = useLookups();
  const { t } = useT();
  const selected = h.selected.has(issue.id);
  const open = (e: MouseEvent | KeyboardEvent<Element>) => {
    if (e.shiftKey || e.metaKey || e.ctrlKey) h.onSelect(issue, e as MouseEvent);
    else h.onOpen(issue, e as MouseEvent);
  };
  return (
    <ListRow
      className="pj-issue-row"
      lead={has(d, "priority") ? <PriorityBtn issue={issue} t={t} canEdit={h.canEdit} /> : undefined}
      id={has(d, "id") ? issue.identifier : undefined}
      title={
        <>
          {has(d, "status") && <StatusBtn issue={issue} L={L} t={t} canEdit={h.canEdit} />}
          <a
            className="pj-row-title"
            href={href(`/issue/${issue.identifier}`)}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.button !== 0) {
                e.stopPropagation();
                return;
              }
              e.preventDefault();
              e.stopPropagation();
              if (tapSelects(h)) h.onSelect(issue, e);
              else open(e);
            }}
            draggable={false}
          >
            {issue.title}
          </a>
          {issue.parentId && (
            <span className="pj-row-parent" aria-hidden="true">
              ↳
            </span>
          )}
        </>
      }
      props={
        <>
          <Meta issue={issue} d={d} L={L} t={t} canEdit={h.canEdit} />
          {has(d, "assignee") && <AssigneeButton issue={issue} L={L} t={t} canEdit={false} />}
        </>
      }
      quick={
        h.canEdit ? (
          <>
            <PropButton kind="assignee" issue={issue} label={t("i.quickAssignee")}>
              {issue.assigneeId ? <Avatar name={L.person.get(issue.assigneeId)?.name ?? "?"} id={issue.assigneeId} size={18} src={L.person.get(issue.assigneeId)?.avatar} /> : <UnassignedIcon size={18} />}
            </PropButton>
            <PropButton kind="due" issue={issue} label={t("i.quickDue")}>
              <CalendarDays size={15} />
            </PropButton>
            <button type="button" className="pj-prop-btn" aria-label={t("i.quickMore")} title={t("i.quickMore")} onClick={(e) => (e.stopPropagation(), h.onMore(issue, e.currentTarget))}>
              <MoreHorizontal size={15} />
            </button>
          </>
        ) : undefined
      }
      check={{ checked: selected, onChange: (_on, e) => h.onSelect(issue, e), label: issue.identifier }}
      selecting={h.selected.size > 0}
      selected={selected}
      focused={h.focused === issue.id}
      onContextMenu={(e) => h.onContext(issue, e)}
    />
  );
});

/** On touch, while issues are selected, a tap adds or removes one (Linear's iOS app). */
const tapSelects = (h: ListHandlers): boolean => h.selected.size > 0 && touchedLast();

/** A click anywhere on a row opens it (the title is the row's link for keyboards and screen readers; no button around buttons). */
function rowClick(e: MouseEvent<HTMLElement>, issue: Issue, h: ListHandlers): void {
  if ((e.target as HTMLElement).closest("button, a, input, [role=menu]")) return;
  if (e.shiftKey || e.metaKey || e.ctrlKey || tapSelects(h)) h.onSelect(issue, e);
  else h.onOpen(issue, e);
}

export function ListView({ groups, d, h, grouped, manual }: { groups: ViewGroup[]; d: IssueDisplay; h: ListHandlers; grouped: boolean; manual: boolean }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const drag = useDropInto(groups, h, manual, ".pj-row-drag");
  return (
    <div className="pj-list">
      {groups.map((g) => (
        <ListGroup
          key={g.info.key}
          g={g}
          d={d}
          h={h}
          grouped={grouped}
          collapsed={collapsed.has(g.info.key)}
          onToggle={() => setCollapsed((s) => (s.has(g.info.key) ? (s.delete(g.info.key), new Set(s)) : new Set(s).add(g.info.key)))}
          drag={drag}
        />
      ))}
    </div>
  );
}

function ListGroup({ g, d, h, grouped, collapsed, onToggle, drag }: { g: ViewGroup; d: IssueDisplay; h: ListHandlers; grouped: boolean; collapsed: boolean; onToggle: () => void; drag: DragStart }) {
  const { t } = useT();
  const line = useDropLine(g.info.key);
  return (
    <section className="pj-group" data-drop-zone={g.info.key} data-over={line.active || undefined}>
      {grouped && (
        <header className="pj-group-head" style={g.info.color ? { ["--pj-group-tint" as string]: uiColor(g.info.color) } : undefined}>
          <button type="button" className="pj-group-toggle" aria-expanded={!collapsed} onClick={onToggle}>
            <ChevronDown size={14} className="pj-chev" data-collapsed={collapsed || undefined} />
            {g.info.icon}
            <span className="pj-group-name">{g.info.label}</span>
            <span className="pj-group-count">{g.count}</span>
          </button>
          {h.canEdit && (
            <button type="button" className="pj-icon-btn pj-group-add" aria-label={t("nav.newIssue")} title={t("nav.newIssue")} onClick={() => h.onCreate(g.info)}>
              <Plus size={15} />
            </button>
          )}
        </header>
      )}
      {!collapsed && (
        <div className="pj-group-rows">
          {g.items.map((it) => (
            <div key={it.id} className="pj-row-wrap" data-drop={line.before(it.id) ? "before" : undefined}>
              <div className="pj-row-drag" data-id={it.id} onPointerDown={(e) => drag(e, it)} onMouseEnter={() => h.onFocus(it)} onClick={(e) => rowClick(e, it, h)}>
                <IssueRow issue={it} d={d} h={h} />
              </div>
            </div>
          ))}
          {line.atEnd && <div className="pj-drop-line" />}
          {g.cursor && (
            <button type="button" className="pj-load-more" onClick={() => h.onLoadMore(g)}>
              {t("i.loadMore", { n: Math.min(50, g.count - g.items.length) })}
            </button>
          )}
          {g.items.length === 0 && grouped && <div className="pj-group-empty">{t("i.empty")}</div>}
        </div>
      )}
    </section>
  );
}

// --- Board ---------------------------------------------------------------------

export const IssueCard = memo(function IssueCard({ issue, d, h, onDragStart }: { issue: Issue; d: IssueDisplay; h: ListHandlers; onDragStart: DragStart }) {
  const L = useLookups();
  const { t } = useT();
  const selected = h.selected.has(issue.id);
  const project = issue.projectId ? L.project.get(issue.projectId) : null;
  return (
    <div
      className="pj-card"
      data-project={project ? "" : undefined}
      style={project ? { ["--pj-card-accent" as string]: uiColor(project.color) } : undefined}
      data-id={issue.id}
      data-selected={selected || undefined}
      data-focused={h.focused === issue.id || undefined}
      onPointerDown={(e) => onDragStart(e, issue)}
      onMouseEnter={() => h.onFocus(issue)}
      onContextMenu={(e) => h.onContext(issue, e)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, a")) return;
        if (e.shiftKey || e.metaKey || e.ctrlKey || tapSelects(h)) h.onSelect(issue, e);
        else h.onOpen(issue, e);
      }}
      data-checked={selected || undefined}
    >
      <div className="pj-card-top">
        {has(d, "id") && <span className="pj-card-id">{issue.identifier}</span>}
        <span className="pj-card-top-end">{has(d, "assignee") && <AssigneeButton issue={issue} L={L} t={t} canEdit={h.canEdit} size={18} />}</span>
      </div>
      <div className="pj-card-title">
        {has(d, "status") && <StatusBtn issue={issue} L={L} t={t} canEdit={h.canEdit} />}
        <a
          href={href(`/issue/${issue.identifier}`)}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey) return;
            e.preventDefault();
            if (tapSelects(h)) h.onSelect(issue, e);
            else h.onOpen(issue, e);
          }}
          draggable={false}
        >
          {issue.title}
        </a>
      </div>
      <div className="pj-card-meta">
        {has(d, "priority") && issue.priority !== 0 && <PriorityBtn issue={issue} t={t} canEdit={h.canEdit} />}
        <Meta issue={issue} d={d} L={L} t={t} compact canEdit={h.canEdit} />
      </div>
    </div>
  );
});

export function BoardView({ groups, d, h, manual }: { groups: ViewGroup[]; d: IssueDisplay; h: ListHandlers; manual: boolean }) {
  const drag = useDropInto(groups, h, manual, ".pj-card");
  return (
    <div className="pj-board">
      {groups.map((g) => (
        <BoardColumn key={g.info.key} g={g} d={d} h={h} drag={drag} />
      ))}
    </div>
  );
}

function BoardColumn({ g, d, h, drag }: { g: ViewGroup; d: IssueDisplay; h: ListHandlers; drag: DragStart }) {
  const { t } = useT();
  const line = useDropLine(g.info.key);
  return (
    <section className="pj-col" data-drop-zone={g.info.key} data-over={line.active || undefined} aria-label={g.info.label}>
      <header className="pj-col-head" style={g.info.color ? { ["--pj-group-tint" as string]: uiColor(g.info.color) } : undefined}>
        {g.info.icon}
        <span className="pj-group-name">{g.info.label}</span>
        <span className="pj-group-count">{g.count}</span>
        {h.canEdit && (
          <button type="button" className="pj-icon-btn pj-group-add" aria-label={t("nav.newIssue")} title={t("nav.newIssue")} onClick={() => h.onCreate(g.info)}>
            <Plus size={15} />
          </button>
        )}
      </header>
      <div className="pj-col-body">
        {g.items.map((it) => (
          <div key={it.id} className="pj-card-wrap" data-drop={line.before(it.id) ? "before" : undefined}>
            <IssueCard issue={it} d={d} h={h} onDragStart={drag} />
          </div>
        ))}
        {line.atEnd && g.items.length > 0 && <div className="pj-drop-line" />}
        {g.cursor && (
          <button type="button" className="pj-load-more" onClick={() => h.onLoadMore(g)}>
            {t("i.loadMore", { n: Math.min(50, g.count - g.items.length) })}
          </button>
        )}
        {h.canEdit ? (
          <button type="button" className="pj-col-add" data-empty={g.items.length === 0 || undefined} onClick={() => h.onCreate(g.info)}>
            <Plus size={14} />
            {t("nav.newIssue")}
          </button>
        ) : (
          g.items.length === 0 && <div className="pj-col-empty">{t("i.empty")}</div>
        )}
      </div>
    </section>
  );
}

// --- Calendar ------------------------------------------------------------------

export function CalendarView({ issues, month, setMonth, h }: { issues: Issue[]; month: string; setMonth: (m: string) => void; h: ListHandlers & { onDue: (issueId: string, day: string) => void } }) {
  const { t, lang } = useT();
  const L = useLookups();
  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const weekStart = weekStartIn(lang);
  const lead = (first.getDay() - weekStart + 7) % 7;
  const days = new Date(y, m, 0).getDate();
  const cells = Math.ceil((lead + days) / 7) * 7;
  const pad = (n: number) => String(n).padStart(2, "0");
  const byDay = new Map<string, Issue[]>();
  for (const i of issues) if (i.dueDate) byDay.set(i.dueDate, [...(byDay.get(i.dueDate) ?? []), i]);
  const raw = new Intl.DateTimeFormat(intlOf(lang), { month: "long", year: "numeric" }).format(first);
  const title = raw.charAt(0).toUpperCase() + raw.slice(1);
  const shift = (n: number) => {
    const d = new Date(y, m - 1 + n, 1);
    setMonth(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
  };
  const wd = weekdayNames(lang, "short", weekStart);
  const ds = useStore(dragState);
  const over = ds.target?.zone ?? null;
  const drag = (e: PointerEvent<HTMLElement>, it: Issue) => {
    if (!h.canEdit) return;
    beginDrag(e, it.id, { itemSelector: ".pj-cal-issue", onDrop: (id, target) => h.onDue(id, target.zone) });
  };
  return (
    <div className="pj-cal">
      <div className="pj-cal-head">
        <button type="button" className="pj-icon-btn" aria-label="‹" onClick={() => shift(-1)}>
          <ChevronLeft size={16} />
        </button>
        <h2>{title}</h2>
        <button type="button" className="pj-icon-btn" aria-label="›" onClick={() => shift(1)}>
          <ChevronRight size={16} />
        </button>
        <button type="button" className="pj-btn pj-btn-sm" onClick={() => setMonth(L.b.today.slice(0, 7))}>
          {t("c.today")}
        </button>
      </div>
      <div className="pj-cal-grid" role="grid">
        {wd.map((w) => (
          <div key={w} className="pj-cal-wd" role="columnheader">
            {w}
          </div>
        ))}
        {Array.from({ length: cells }, (_, i) => {
          const dayN = i - lead + 1;
          if (dayN < 1 || dayN > days) return <div key={i} className="pj-cal-cell pj-cal-out" />;
          const day = `${y}-${pad(m)}-${pad(dayN)}`;
          const list = byDay.get(day) ?? [];
          return (
            <div
              key={i}
              className="pj-cal-cell"
              role="gridcell"
              data-today={day === L.b.today || undefined}
              data-over={over === day || undefined}
              data-drop-zone={day}
            >
              <div className="pj-cal-day">{dayN}</div>
              {list.slice(0, 6).map((it) => {
                const s = L.status.get(it.statusId);
                return (
                  <a
                    key={it.id}
                    className="pj-cal-issue"
                    href={href(`/issue/${it.identifier}`)}
                    data-id={it.id}
                    draggable={false}
                    onPointerDown={(e) => drag(e, it)}
                    onContextMenu={(e) => h.onContext(it, e)}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey) return;
                      e.preventDefault();
                      h.onOpen(it, e);
                    }}
                    title={`${it.identifier} ${it.title}`}
                  >
                    {s && <StatusIcon category={s.category} color={s.color} fraction={L.fraction(s.id)} size={12} />}
                    <span>{it.title}</span>
                  </a>
                );
              })}
              {list.length > 6 && <div className="pj-cal-more">+{list.length - 6}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
