"use client";

// Property pickers of issues (status, priority, assignee, labels, project,
// cycle, estimate, due date, team, milestone), the buttons that open them,
// and the context menu of an issue or a selection. Every change is sent to
// the server; the lists update at once and are corrected by the answer.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pill, type PillTone } from "@/components/zvena/ds";
import { Archive, ArchiveRestore, CalendarDays, ChevronRight, Copy, Hash, Link2, Tag, Trash2, Users, UserCircle2, Box, RefreshCcw, Gauge, ExternalLink, BellRing, SquareCheck } from "lucide-react";
import { ESTIMATE_SCALES, estimateLabel, PRIORITIES, type Issue, type Priority } from "@/lib/projects/types";
import { api, deleteWithUndo, errorText, invalidateAll, loadBoot, offerUndo, saveIssue, saveIssues, toast, useLookups, type Lookups } from "./data";
import { CycleGlyph, Glyph, PriorityIcon, ProjectGlyph, StatusIcon, uiColor } from "./icons";
import { useT, type PT } from "./i18n";
import { href, navigate, setParams } from "./router";
import { Avatar, DatePicker, Menu, Popover, UnassignedIcon, usePopover, type Anchor, type MenuItem } from "./ui";

// --- Applying changes ----------------------------------------------------------

/** The previous values of the fields a patch changes (to take the change back). */
function previous(issue: Issue, patch: Record<string, unknown>): Record<string, unknown> {
  const prev: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) {
    if (k === "archived") prev.archived = Boolean(issue.archivedAt);
    else if (k === "addLabelIds" || k === "removeLabelIds") prev.labelIds = issue.labelIds;
    else if (k === "teamId") prev.teamId = issue.teamId;
    else if (k in issue) prev[k] = (issue as unknown as Record<string, unknown>)[k];
  }
  return prev;
}

export function useApply() {
  const { t } = useT();
  return async (issues: Issue[], patch: Record<string, unknown>, optimistic: Partial<Issue> = {}) => {
    const onError = (e: unknown) => toast(errorText(e, t), "error");
    const before = issues.map((i) => ({ id: i.id, prev: previous(i, patch) }));
    const ok =
      issues.length === 1
        ? Boolean(await saveIssue(issues[0].id, patch, { ...patchToOptimistic(patch), ...optimistic }, onError))
        : await saveIssues(
            issues.map((i) => i.id),
            patch,
            { ...patchToOptimistic(patch), ...optimistic },
            onError
          );
    // Bulk changes, archiving and moves to another team can be taken back.
    if (ok && (issues.length > 1 || "archived" in patch || "teamId" in patch)) {
      const text = "archived" in patch && patch.archived ? t("i.archived") : issues.length > 1 ? t("i.changedMany", { n: issues.length }) : t("i.moved");
      offerUndo(text, () => {
        for (const b of before) void saveIssue(b.id, b.prev, patchToOptimistic(b.prev), onError);
      });
    }
    return ok;
  };
}

function patchToOptimistic(p: Record<string, unknown>): Partial<Issue> {
  const o: Partial<Issue> = {};
  for (const k of ["statusId", "priority", "assigneeId", "projectId", "cycleId", "dueDate", "estimate", "labelIds", "milestoneId", "parentId"] as const) {
    if (k in p && !(k === "statusId" && String(p[k]).startsWith("category:"))) (o as Record<string, unknown>)[k] = p[k];
  }
  return o;
}

// --- Pickers -------------------------------------------------------------------

type Close = { onClose: () => void };

export function StatusPicker({ teamId, value, onPick, onClose }: { teamId: string; value?: string; onPick: (id: string) => void } & Close) {
  const L = useLookups();
  const { t } = useT();
  const items: MenuItem[] = L.statusesOf(teamId).map((s, i) => ({
    id: s.id,
    label: s.name,
    icon: <StatusIcon category={s.category} color={s.color} fraction={L.fraction(s.id)} />,
    checked: s.id === value,
    hotkey: i < 9 ? String(i + 1) : undefined,
    onSelect: () => onPick(s.id),
  }));
  return <Menu items={items} onClose={onClose} placeholder={t("cmd.setStatus")} />;
}

export function PriorityPicker({ value, onPick, onClose }: { value?: Priority; onPick: (p: Priority) => void } & Close) {
  const { t } = useT();
  const items: MenuItem[] = PRIORITIES.map((p) => ({
    id: String(p),
    label: t(`prio.${p}`),
    icon: <PriorityIcon priority={p} />,
    checked: p === value,
    hotkey: String(p),
    onSelect: () => onPick(p),
  }));
  return <Menu items={items} onClose={onClose} placeholder={t("cmd.setPriority")} />;
}

export function AssigneePicker({ value, onPick, onClose }: { value?: string | null; onPick: (id: string | null) => void } & Close) {
  const L = useLookups();
  const { t } = useT();
  const me = L.b.me.id;
  const people = L.b.people.filter((p) => p.role !== null).sort((a, b) => (a.id === me ? -1 : b.id === me ? 1 : a.name.localeCompare(b.name)));
  const items: MenuItem[] = [
    { id: "none", label: t("i.unassigned"), icon: <UnassignedIcon size={18} />, checked: value === null, hotkey: "0", onSelect: () => onPick(null) },
    ...people.map((p) => ({
      id: p.id,
      label: p.id === me ? `${p.name} (${t("c.you")})` : p.name,
      icon: <Avatar name={p.name} id={p.id} size={18} src={p.avatar} />,
      checked: p.id === value,
      onSelect: () => onPick(p.id),
    })),
  ];
  return <Menu items={items} onClose={onClose} placeholder={t("cmd.assign")} />;
}

export function LabelPicker({ teamId, value, onToggle, onClose }: { teamId: string | null; value: string[]; onToggle: (id: string, on: boolean) => void } & Close) {
  const L = useLookups();
  const { t } = useT();
  const [, force] = useState(0);
  const groups = new Map(L.b.labels.filter((l) => l.isGroup).map((g) => [g.id, g.name]));
  const items: MenuItem[] = L.b.labels
    .filter((l) => !l.isGroup && (!l.teamId || !teamId || l.teamId === teamId))
    .sort((a, b) => (a.parentId ?? "").localeCompare(b.parentId ?? "") || a.name.localeCompare(b.name))
    .map((l) => ({
      id: l.id,
      label: l.parentId ? `${groups.get(l.parentId) ?? ""} › ${l.name}` : l.name,
      icon: <span className="pj-dot" style={{ background: uiColor(l.color) }} />,
      checked: value.includes(l.id),
      onSelect: () => onToggle(l.id, !value.includes(l.id)),
    }));
  return (
    <Menu
      items={items}
      multi
      onClose={onClose}
      placeholder={t("cmd.labels")}
      onCreate={
        L.canEdit
          ? (name) =>
              void api<{ id: string }>("labels", { method: "POST", body: { name, teamId: null } })
                .then(async (l) => {
                  await loadBoot();
                  onToggle(l.id, true);
                  force((x) => x + 1);
                })
                .catch((e) => toast(errorText(e, t), "error"))
          : undefined
      }
      createLabel={(name) => t("c.newLabel", { name })}
    />
  );
}

export function ProjectPicker({ value, onPick, onClose }: { value?: string | null; onPick: (id: string | null) => void } & Close) {
  const L = useLookups();
  const { t } = useT();
  const items: MenuItem[] = [
    { id: "none", label: t("i.noProject"), icon: <Box size={15} className="pj-muted-icon" />, checked: value === null, onSelect: () => onPick(null) },
    ...L.b.projects
      .filter((p) => !p.archivedAt)
      .map((p) => ({ id: p.id, label: p.name, icon: <ProjectGlyph icon={p.icon} color={p.color} />, checked: p.id === value, onSelect: () => onPick(p.id) })),
  ];
  return <Menu items={items} onClose={onClose} placeholder={t("cmd.project")} />;
}

export function CyclePicker({ teamId, value, onPick, onClose }: { teamId: string; value?: string | null; onPick: (id: string | null) => void } & Close) {
  const L = useLookups();
  const { t } = useT();
  const cur = L.currentCycle(teamId);
  const items: MenuItem[] = [
    { id: "none", label: t("i.noCycle"), icon: <RefreshCcw size={14} className="pj-muted-icon" />, checked: value === null, onSelect: () => onPick(null) },
    ...L.b.cycles
      .filter((c) => c.teamId === teamId && !c.completedAt && c.endsOn >= L.b.today)
      .map((c) => ({
        id: c.id,
        label: `${c.name || t("cy.name", { n: c.number })}${c.id === cur?.id ? ` · ${t("cy.current")}` : ""}`,
        hint: `${c.startsOn} – ${c.endsOn}`,
        right: <span className="pj-menu-hint">{c.startsOn.slice(5)} – {c.endsOn.slice(5)}</span>,
        icon: <CycleGlyph progress={c.progress.total ? c.progress.completed / c.progress.total : 0} />,
        checked: c.id === value,
        onSelect: () => onPick(c.id),
      })),
  ];
  return <Menu items={items} onClose={onClose} placeholder={t("cmd.cycle")} />;
}

export function EstimatePicker({ teamId, value, onPick, onClose }: { teamId: string; value?: number | null; onPick: (v: number | null) => void } & Close) {
  const L = useLookups();
  const { t } = useT();
  const scale = L.team.get(teamId)?.estimates ?? "none";
  const items: MenuItem[] = [
    { id: "none", label: t("i.noEstimate"), icon: <Gauge size={14} className="pj-muted-icon" />, checked: value === null, onSelect: () => onPick(null) },
    ...ESTIMATE_SCALES[scale].map((v, i) => ({ id: String(v), label: estimateLabel(scale, v), icon: <Gauge size={14} />, checked: v === value, hotkey: i < 9 ? String(i + 1) : undefined, onSelect: () => onPick(v) })),
  ];
  return <Menu items={items} onClose={onClose} placeholder={t("cmd.estimate")} search={false} />;
}

export function TeamPicker({ value, onPick, onClose }: { value?: string; onPick: (id: string) => void } & Close) {
  const L = useLookups();
  const { t } = useT();
  const items: MenuItem[] = L.b.teams
    .filter((x) => !x.archivedAt)
    .map((x) => ({ id: x.id, label: x.name, hint: x.key, right: <span className="pj-menu-hint">{x.key}</span>, icon: <Glyph icon={x.icon} color={x.color} text={x.name} size={16} />, checked: x.id === value, onSelect: () => onPick(x.id) }));
  return <Menu items={items} onClose={onClose} placeholder={t("f.team")} />;
}

export function MilestonePicker({ projectId, value, onPick, onClose }: { projectId: string; value?: string | null; onPick: (id: string | null) => void } & Close) {
  const L = useLookups();
  const { t } = useT();
  const p = L.project.get(projectId);
  const items: MenuItem[] = [
    { id: "none", label: t("i.noMilestone"), checked: value === null, onSelect: () => onPick(null) },
    ...(p?.milestones ?? []).map((m) => ({ id: m.id, label: m.name, hint: m.targetDate ?? "", checked: m.id === value, onSelect: () => onPick(m.id) })),
  ];
  return <Menu items={items} onClose={onClose} placeholder={t("p.milestone")} />;
}

/** One picker for a property of one or many issues (used by buttons, menus, shortcuts and the palette). */
export type PropKind = "status" | "priority" | "assignee" | "labels" | "project" | "cycle" | "estimate" | "due" | "team" | "milestone";

export function PropPicker({ kind, issues, onClose }: { kind: PropKind; issues: Issue[]; onClose: () => void }) {
  const apply = useApply();
  const L = useLookups();
  const first = issues[0];
  const same = <K extends keyof Issue>(k: K): Issue[K] | undefined => (issues.every((i) => i[k] === first[k]) ? first[k] : undefined);
  const teamId = issues.every((i) => i.teamId === first.teamId) ? first.teamId : null;
  switch (kind) {
    case "status":
      if (!teamId) {
        // Issues of several teams: pick by status category.
        return <CategoryPicker onClose={onClose} onPick={(cat) => void apply(issues, { statusId: `category:${cat}` })} />;
      }
      return <StatusPicker teamId={teamId} value={same("statusId")} onClose={onClose} onPick={(id) => void apply(issues, { statusId: id })} />;
    case "priority":
      return <PriorityPicker value={same("priority")} onClose={onClose} onPick={(p) => void apply(issues, { priority: p })} />;
    case "assignee":
      return <AssigneePicker value={same("assigneeId")} onClose={onClose} onPick={(id) => void apply(issues, { assigneeId: id })} />;
    case "labels": {
      const common = first.labelIds.filter((l) => issues.every((i) => i.labelIds.includes(l)));
      return (
        <LabelPicker
          teamId={teamId}
          value={common}
          onClose={onClose}
          onToggle={(id, on) => {
            if (issues.length === 1) {
              const next = on ? [...first.labelIds, id] : first.labelIds.filter((x) => x !== id);
              const label = L.label.get(id);
              // One label per group: picking one replaces its sibling.
              const cleaned = on && label?.parentId ? next.filter((x) => x === id || L.label.get(x)?.parentId !== label.parentId) : next;
              void apply(issues, { labelIds: cleaned });
            } else void apply(issues, on ? { addLabelIds: [id] } : { removeLabelIds: [id] });
          }}
        />
      );
    }
    case "project":
      return <ProjectPicker value={same("projectId")} onClose={onClose} onPick={(id) => void apply(issues, { projectId: id })} />;
    case "cycle":
      return teamId ? <CyclePicker teamId={teamId} value={same("cycleId")} onClose={onClose} onPick={(id) => void apply(issues, { cycleId: id })} /> : null;
    case "estimate":
      return teamId ? <EstimatePicker teamId={teamId} value={same("estimate")} onClose={onClose} onPick={(v) => void apply(issues, { estimate: v })} /> : null;
    case "due":
      return <DatePicker value={same("dueDate") ?? null} onClose={onClose} onPick={(v) => void apply(issues, { dueDate: v })} />;
    case "team":
      return <TeamPicker value={teamId ?? undefined} onClose={onClose} onPick={(id) => void apply(issues, { teamId: id })} />;
    case "milestone":
      return first.projectId ? <MilestonePicker projectId={first.projectId} value={same("milestoneId")} onClose={onClose} onPick={(id) => void apply(issues, { milestoneId: id })} /> : null;
  }
}

function CategoryPicker({ onPick, onClose }: { onPick: (c: string) => void } & Close) {
  const { t } = useT();
  const colors: Record<string, string> = { backlog: "#95a2b3", unstarted: "#99a2b2", started: "#f2c94c", completed: "#5e6ad2", canceled: "#95a2b3" };
  const items: MenuItem[] = (["backlog", "unstarted", "started", "completed", "canceled"] as const).map((c, i) => ({
    id: c,
    label: t(`cat.${c}`),
    icon: <StatusIcon category={c} color={colors[c]} />,
    hotkey: String(i + 1),
    onSelect: () => onPick(c),
  }));
  return <Menu items={items} onClose={onClose} />;
}

// --- Property buttons ----------------------------------------------------------

/** A button showing an issue property that opens its picker (rows, cards, detail). */
export function PropButton({ kind, issue, children, label, className, disabled }: { kind: PropKind; issue: Issue; children: ReactNode; label: string; className?: string; disabled?: boolean }) {
  const pop = usePopover();
  return (
    <>
      <button
        type="button"
        className={`pj-prop-btn ${className ?? ""}`}
        title={label}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          pop.toggle(e.currentTarget);
        }}
      >
        <span className="pj-sr">{label}: </span>
        {children}
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={kind === "due" ? 268 : 260} label={label}>
          <PropPicker kind={kind} issues={[issue]} onClose={pop.close} />
        </Popover>
      )}
    </>
  );
}

/** A property as zvena's Pill (design system: PropertyPill): shows the value, edits it in one click. */
export function PropPill({ kind, issue, canEdit, icon, dot, tone, title, children }: { kind: PropKind; issue: Issue; canEdit: boolean; icon?: ReactNode; dot?: string; tone?: PillTone; title?: string; children: ReactNode }) {
  const pop = usePopover();
  return (
    <>
      <Pill
        icon={icon}
        dot={dot}
        tone={tone}
        title={title}
        onClick={
          canEdit
            ? (e) => {
                e.stopPropagation();
                e.preventDefault();
                pop.toggle(e.currentTarget);
              }
            : undefined
        }
      >
        {children}
      </Pill>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={kind === "due" ? 268 : 260} label={title}>
          <PropPicker kind={kind} issues={[issue]} onClose={pop.close} />
        </Popover>
      )}
    </>
  );
}

/** A due date as people say it: today, tomorrow, yesterday, else the date. */
export function dueWord(due: string, today: string, t: PT, day: (d: string) => string): string {
  const diff = Math.round((Date.parse(`${due}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
  if (diff === 0) return t("c.today");
  if (diff === 1) return t("c.tomorrow");
  if (diff === -1) return t("c.yesterday");
  return day(due);
}

/** Finds an issue by identifier or words (for relations and "set parent"). */
export function IssueSearch({ exclude, onPick, onClose }: { exclude: string[]; onPick: (i: { id: string; identifier: string; title: string }) => void; onClose: () => void }) {
  const { t } = useT();
  const L = useLookups();
  const [q, setQ] = useState("");
  const [res, setRes] = useState<{ id: string; identifier: string; title: string; statusId: string }[]>([]);
  useEffect(() => {
    const term = q.trim();
    if (!term) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      void api<{ issues: { id: string; identifier: string; title: string; statusId: string }[] }>("search", { query: { q: term }, signal: ctl.signal })
        .then((r) => setRes(r.issues.filter((i) => !exclude.includes(i.id))))
        .catch(() => undefined);
    }, 180);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [q, exclude]);
  const items: MenuItem[] = (q.trim() ? res : []).map((i) => {
    const s = L.status.get(i.statusId);
    return { id: i.id, label: `${i.identifier} ${i.title}`, icon: s ? <StatusIcon category={s.category} color={s.color} fraction={L.fraction(s.id)} /> : undefined, onSelect: () => onPick(i) };
  });
  return (
    <div className="pj-issue-search">
      <div className="pj-menu-search">
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("s.placeholder")} aria-label={t("nav.search")} />
      </div>
      {q.trim() ? <Menu items={items} onClose={onClose} search={false} emptyText={t("s.nothing")} /> : <div className="pj-menu-empty">{t("s.hint")}</div>}
    </div>
  );
}

/**
 * Marks an issue as a duplicate of another (Linear): the relation, and the
 * server moves it to its team's Duplicate status.
 */
export function markDuplicate(issue: Issue, of: { id: string; identifier: string }, t: PT): void {
  void api(`issues/${issue.id}/relations`, { method: "POST", body: { type: "duplicate", relatedId: of.id } })
    .then(() => {
      invalidateAll();
      toast(t("tr.markedDup", { id: issue.identifier, of: of.identifier }), "success");
    })
    .catch((e) => toast(errorText(e, t), "error"));
}

// --- Context menu --------------------------------------------------------------

export function issueUrl(issue: Issue): string {
  return `${location.origin}${href(`/issue/${issue.identifier}`)}`;
}

export function copy(text: string, t: PT): void {
  void navigator.clipboard?.writeText(text).then(
    () => toast(t("i.copied"), "success"),
    () => toast(text)
  );
}

/** Deletes at once; the toast (or Ctrl/Cmd+Z) brings the issues back within a few seconds. */
export function deleteIssues(issues: Issue[], t: PT, after?: () => void): void {
  if (!issues.length) return;
  deleteWithUndo(
    issues.map((i) => i.id),
    issues.length === 1 ? `${issues[0].identifier} · ${t("i.deleted")}` : t("i.deletedMany", { n: issues.length }),
    (e) => toast(errorText(e, t), "error")
  );
  after?.();
}

export function IssueContextMenu({ issues, anchor, onClose, onSelect }: { issues: Issue[]; anchor: Anchor; onClose: () => void; onSelect?: () => void }) {
  const { t } = useT();
  const L = useLookups();
  const apply = useApply();
  const [sub, setSub] = useState<PropKind | "duplicate" | null>(null);
  const one = issues.length === 1 ? issues[0] : null;
  const items = useMemo<MenuItem[]>(() => {
    const arrow = <ChevronRight size={14} className="pj-menu-arrow" />;
    const list: MenuItem[] = [];
    // Touch (a long press): starts picking issues; then taps add or remove them (Linear's iOS app).
    if (onSelect) list.push({ id: "select", label: t("k.select"), icon: <SquareCheck size={15} />, onSelect });
    if (L.canEdit) {
      list.push(
        { id: "status", label: t("f.status"), icon: <StatusIcon category="started" color="currentColor" fraction={0.5} />, right: arrow, hotkey: "s", keepOpen: true, onSelect: () => setSub("status") },
        { id: "priority", label: t("f.priority"), icon: <PriorityIcon priority={2} />, right: arrow, hotkey: "p", keepOpen: true, onSelect: () => setSub("priority") },
        { id: "assignee", label: t("f.assignee"), icon: <UserCircle2 size={15} />, right: arrow, hotkey: "a", keepOpen: true, onSelect: () => setSub("assignee") },
        { id: "labels", label: t("f.labels"), icon: <Tag size={15} />, right: arrow, hotkey: "l", keepOpen: true, onSelect: () => setSub("labels") },
        { id: "project", label: t("f.project"), icon: <Box size={15} />, right: arrow, keepOpen: true, onSelect: () => setSub("project") },
        { id: "due", label: t("f.due"), icon: <CalendarDays size={15} />, right: arrow, hotkey: "d", keepOpen: true, onSelect: () => setSub("due") }
      );
      if (issues.every((i) => i.teamId === issues[0].teamId)) {
        if (L.team.get(issues[0].teamId)?.cyclesEnabled) list.push({ id: "cycle", label: t("f.cycle"), icon: <RefreshCcw size={14} />, right: arrow, keepOpen: true, onSelect: () => setSub("cycle") });
        if (L.team.get(issues[0].teamId)?.estimates !== "none") list.push({ id: "estimate", label: t("p.estimate"), icon: <Gauge size={14} />, right: arrow, hotkey: "e", keepOpen: true, onSelect: () => setSub("estimate") });
      }
      list.push({ id: "team", label: t("i.moveTeam"), icon: <Users size={15} />, right: arrow, keepOpen: true, onSelect: () => setSub("team") });
      if (one) list.push({ id: "duplicate", label: t("i.markDuplicate"), icon: <Copy size={15} />, right: arrow, keepOpen: true, onSelect: () => setSub("duplicate") });
    }
    if (one) {
      list.push(
        { id: "open", label: t("i.open"), icon: <ExternalLink size={15} />, onSelect: () => navigate(`/issue/${one.identifier}`) },
        { id: "peek", label: t("i.peek"), icon: <Hash size={15} />, onSelect: () => setParams({ peek: one.identifier }) },
        { id: "copyId", label: t("i.copyId"), icon: <Copy size={15} />, onSelect: () => copy(one.identifier, t) },
        { id: "copyLink", label: t("i.copyLink"), icon: <Link2 size={15} />, onSelect: () => copy(issueUrl(one), t) },
        {
          id: "subscribe",
          label: t("i.subscribe"),
          icon: <BellRing size={15} />,
          onSelect: () => void api(`issues/${one.id}/subscribe`, { method: "POST", body: { on: true } }).then(() => toast(t("i.subscribe"), "success")),
        }
      );
    }
    if (L.canEdit) {
      const archived = issues.every((i) => i.archivedAt);
      list.push(
        archived
          ? { id: "unarchive", label: t("i.unarchive"), icon: <ArchiveRestore size={15} />, onSelect: () => void apply(issues, { archived: false }) }
          : { id: "archive", label: t("i.archive"), icon: <Archive size={15} />, onSelect: () => void apply(issues, { archived: true }) },
        { id: "delete", label: t("i.delete"), icon: <Trash2 size={15} />, danger: true, onSelect: () => deleteIssues(issues, t) }
      );
    }
    return list;
  }, [L, t, issues, one, apply, onSelect]);
  if (!anchor) return null;
  return (
    <Popover anchor={anchor} onClose={onClose} width={sub === "due" ? 268 : sub === "duplicate" ? 320 : 240} label={one ? one.identifier : t("i.selected", { n: issues.length })}>
      {sub === "duplicate" && one ? (
        <IssueSearch
          exclude={[one.id]}
          onClose={onClose}
          onPick={(of) => {
            onClose();
            markDuplicate(one, of, t);
          }}
        />
      ) : sub && sub !== "duplicate" ? (
        <PropPicker kind={sub} issues={issues} onClose={onClose} />
      ) : (
        <>
          {!one && <div className="pj-menu-group">{t("i.selected", { n: issues.length })}</div>}
          <Menu items={items} onClose={onClose} search={false} />
        </>
      )}
    </Popover>
  );
}

export function personName(L: Lookups, id: string | null, t: PT): string {
  if (!id) return t("i.unassigned");
  return L.person.get(id)?.name ?? t("act.former");
}
