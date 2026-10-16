"use client";

// One issue: the full page (/projects/issue/ZVN-12) and the side panel
// (?peek=ZVN-12) share this component. Title and description save as you
// type; properties, sub-issues, relations, attachments, comments and the
// history all go through the server with permission checks there.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  Ban,
  Bell,
  CalendarDays,
  BellOff,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Gauge,
  GitBranch,
  Link2,
  Maximize2,
  MoreHorizontal,
  OctagonAlert,
  Paperclip,
  Plus,
  Smile,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { estimateLabel, type Activity, type Comment, type CustomField, type Issue, type IssueDetail as Detail, type RelationType } from "@/lib/projects/types";
import { setTarget } from "./app-state";
import { api, errorText, invalidateAll, loadBoot, patchCachedIssue, saveIssue, toast, toggleFavorite, useLookups, useQuery, workspaceId, type Lookups } from "./data";
import { AssistIssue, IssueSuggestions } from "./Assistant";
import { TriageBar } from "./Triage";
import { IssueEcosystem } from "@/components/eco/IssueEcosystem";
import { MarkdownEditor, MarkdownView } from "./Editor";
import { CycleGlyph, Glyph, PriorityIcon, ProjectGlyph, StatusIcon, uiColor } from "./icons";
import { useT, type PT } from "./i18n";
import { copy, deleteIssues, dueWord, IssueSearch, issueUrl, personName, PropButton, PropPicker, PropPill, type PropKind } from "./pickers";

export { IssueSearch };
import { Link, navigate, setParams } from "./router";
import { Avatar, bytes, Empty, ErrorState, IconButton, LoadingRows, Menu, Popover, UnassignedIcon, useFormat, usePopover, type MenuItem } from "./ui";
import { useKeyboardInset } from "./keyboard";

/** `onClose`: what the peek's ✕ does where the issue is not the ?peek= panel (the inbox, triage). */
export function IssueDetailView({ issueRef, mode, triage, onClose }: { issueRef: string; mode: "page" | "peek"; triage?: { keys: boolean; onDone: () => void }; onClose?: () => void }) {
  const { t } = useT();
  const { data, error, loading, reload } = useQuery<Detail>(`issue:${issueRef}`, () => api<Detail>(`issues/${encodeURIComponent(issueRef)}`));
  useEffect(() => {
    // Opening an issue marks its notifications read; the inbox badge follows.
    if (data) void loadBoot();
  }, [data?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return error.status === 404 || error.status === 403 ? <Empty title={t("i.notFound")} /> : <ErrorState onRetry={reload} />;
  if (loading || !data) return <LoadingRows rows={8} />;
  return <Loaded issue={data} mode={mode} triage={triage} onClose={onClose} />;
}

function Loaded({ issue, mode, triage, onClose }: { issue: Detail; mode: "page" | "peek"; triage?: { keys: boolean; onDone: () => void }; onClose?: () => void }) {
  const { t } = useT();
  const L = useLookups();
  const team = L.team.get(issue.teamId);
  const canEdit = L.canEdit && !issue.archivedAt;
  const [uploading, setUploading] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const save = (patch: Record<string, unknown>, optimistic: Partial<Issue> = {}) => saveIssue(issue.id, patch, optimistic, (e) => toast(errorText(e, t), "error"));
  // The open issue page is what shortcuts (S, P, A…) and the palette act on.
  useEffect(() => {
    if (mode !== "page") return;
    setTarget([issue]);
    return () => setTarget([]);
  }, [issue, mode]);

  const upload = async (file: File): Promise<{ url: string; name: string; image: boolean } | null> => {
    setUploading((n) => n + 1);
    try {
      const a = await api<{ url: string; name: string; image: boolean }>(`issues/${issue.id}/attachments`, {
        method: "POST",
        raw: file,
        headers: { "content-type": file.type || "application/octet-stream", "x-file-name": encodeURIComponent(file.name) },
      });
      invalidateAll();
      return a;
    } catch (e) {
      toast(errorText(e, t), "error");
      return null;
    } finally {
      setUploading((n) => n - 1);
    }
  };

  const main = (
    <div
      className="pj-issue-main"
      onDragOver={(e) => {
        if (canEdit && e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragOver(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length || !canEdit) return;
        if ((e.target as HTMLElement).closest(".pj-editor")) return; // the editor takes its own drops
        e.preventDefault();
        setDragOver(false);
        for (const f of Array.from(e.dataTransfer.files).slice(0, 10)) void upload(f);
      }}
      data-drag={dragOver || undefined}
    >
      {issue.parent && (
        <div className="pj-issue-parent">
          <GitBranch size={13} />
          <Link to={`/issue/${issue.parent.identifier}`}>
            {issue.parent.identifier} {issue.parent.title}
          </Link>
        </div>
      )}
      {issue.triage && !issue.archivedAt && <TriageBar issue={issue} keys={triage?.keys} onDone={triage?.onDone} />}
      {issue.archivedAt && (
        <div className="pj-banner">
          <Archive size={14} />
          {t("i.archived")}
          {L.canEdit && (
            <button type="button" className="pj-link" onClick={() => void save({ archived: false }, { archivedAt: null })}>
              {t("i.unarchive")}
            </button>
          )}
        </div>
      )}
      {/* The page's heading for screen readers (a peek sits under its list's heading). */}
      {mode === "page" ? (
        <h1 className="pj-sr">
          {issue.identifier} {issue.title}
        </h1>
      ) : (
        <h2 className="pj-sr">
          {issue.identifier} {issue.title}
        </h2>
      )}
      <TitleField issue={issue} canEdit={canEdit} onSave={(title) => void save({ title }, { title })} />
      <MarkdownEditor
        key={issue.id}
        value={issue.description}
        editable={canEdit}
        placeholder={canEdit ? t("i.description") : ""}
        people={L.b.people}
        toolbar
        onChange={(md) => void save({ description: md })}
        onUpload={canEdit ? upload : undefined}
        className="pj-description"
        label={t("c.description")}
      />
      {mode === "peek" && <PropertyStrip issue={issue} canEdit={canEdit} />}
      <IssueSuggestions issue={issue} canEdit={canEdit} />
      <SubIssues issue={issue} canEdit={canEdit} />
      <Relations issue={issue} canEdit={canEdit} />
      {/* zvena's ecosystem: the docs and designs of this issue (components/eco). */}
      <IssueEcosystem ws={workspaceId()} issueId={issue.id} canEdit={canEdit} />
      <section className="pj-section">
        <div className="pj-section-head">
          <h2>
            {t("i.attachments")} {issue.attachmentList.length > 0 && <span className="pj-group-count">{issue.attachmentList.length}</span>}
          </h2>
          {canEdit && (
            <button type="button" className="pj-btn pj-btn-sm pj-btn-ghost" onClick={() => fileRef.current?.click()}>
              <Paperclip size={14} />
              {uploading ? t("i.uploading") : t("i.attach")}
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              for (const f of Array.from(e.target.files ?? []).slice(0, 10)) void upload(f);
              e.target.value = "";
            }}
          />
        </div>
        <Attachments issue={issue} canEdit={canEdit} />
        {dragOver && <div className="pj-dropzone">{t("i.dropFiles")}</div>}
      </section>
      <AssistIssue issue={issue} canEdit={canEdit} />
      <Timeline issue={issue} />
    </div>
  );

  return (
    <div className="pj-issue" data-mode={mode}>
      <IssueHeader issue={issue} mode={mode} team={team?.name ?? ""} onClose={onClose} />
      <div className="pj-issue-body">
        {main}
        {mode === "page" && (
          <aside className="pj-issue-side" aria-label={t("i.properties")}>
            <Properties issue={issue} canEdit={canEdit} />
          </aside>
        )}
      </div>
    </div>
  );
}

function IssueHeader({ issue, mode, team, onClose }: { issue: Detail; mode: "page" | "peek"; team: string; onClose?: () => void }) {
  const { t } = useT();
  const L = useLookups();
  const more = usePopover();
  const fav = L.isFavorite("issue", issue.id);
  const t0 = L.team.get(issue.teamId);
  const items: MenuItem[] = [
    { id: "copyId", label: t("i.copyId"), icon: <Copy size={14} />, onSelect: () => copy(issue.identifier, t) },
    { id: "copyLink", label: t("i.copyLink"), icon: <Link2 size={14} />, onSelect: () => copy(issueUrl(issue), t) },
    { id: "fav", label: fav ? t("c.unfavorite") : t("c.favorite"), icon: <Star size={14} />, onSelect: () => void toggleFavorite("issue", issue.id, !fav) },
  ];
  if (L.canEdit) {
    items.push(
      issue.archivedAt
        ? { id: "unarchive", label: t("i.unarchive"), icon: <ArchiveRestore size={14} />, onSelect: () => void saveIssue(issue.id, { archived: false }, { archivedAt: null }) }
        : { id: "archive", label: t("i.archive"), icon: <Archive size={14} />, onSelect: () => void saveIssue(issue.id, { archived: true }, { archivedAt: Date.now() }).then(() => toast(t("i.archived"), "success")) },
      {
        id: "delete",
        label: t("i.delete"),
        icon: <Trash2 size={14} />,
        danger: true,
        onSelect: () =>
          deleteIssues([issue], t, () => {
            if (mode === "peek") (onClose ?? (() => setParams({ peek: null })))();
            else navigate(t0 ? `/team/${t0.key}/issues` : "/issues");
          }),
      }
    );
  }
  return (
    // On the page (not the peek) it is the screen's header (.pj-head): on phones the shell's menu button sits at its start (responsive/shell.css).
    <header className={mode === "page" ? "pj-issue-head pj-head" : "pj-issue-head"}>
      <nav className="pj-crumbs" aria-label={t("a11y.breadcrumbs")}>
        {t0 && <Glyph icon={t0.icon} color={t0.color} text={t0.name} size={16} />}
        {t0 ? <Link to={`/team/${t0.key}/issues`}>{team}</Link> : <span>{team}</span>}
        <ChevronRight size={13} />
        <span className="pj-crumb-id">{issue.identifier}</span>
        {issue.aliases.length > 0 && (
          <span className="pj-small pj-muted" title={t("i.aliases")}>
            ({issue.aliases.join(", ")})
          </span>
        )}
      </nav>
      <div className="pj-issue-head-actions">
        <SubscribeButton issue={issue} />
        <IconButton label={fav ? t("c.unfavorite") : t("c.favorite")} active={fav} onClick={() => void toggleFavorite("issue", issue.id, !fav)}>
          <Star size={15} fill={fav ? "currentColor" : "none"} />
        </IconButton>
        <IconButton label={t("i.copyLink")} onClick={() => copy(issueUrl(issue), t)}>
          <Link2 size={15} />
        </IconButton>
        {mode === "peek" && (
          <IconButton label={t("i.fullPage")} onClick={() => navigate(`/issue/${issue.identifier}`)}>
            <Maximize2 size={15} />
          </IconButton>
        )}
        <IconButton label={t("i.moreActions")} onClick={(e) => more.toggle(e.currentTarget)}>
          <MoreHorizontal size={16} />
        </IconButton>
        {mode === "peek" && (
          <IconButton label={t("i.close")} kbd="Esc" onClick={onClose ?? (() => setParams({ peek: null }))}>
            <X size={16} />
          </IconButton>
        )}
      </div>
      {more.anchor && (
        <Popover anchor={more.anchor} onClose={more.close} width={220} align="end" label={t("i.moreActions")}>
          <Menu items={items} onClose={more.close} search={false} />
        </Popover>
      )}
    </header>
  );
}

function SubscribeButton({ issue }: { issue: Detail }) {
  const { t } = useT();
  const L = useLookups();
  const [on, setOn] = useState(issue.subscribed);
  const [was, setWas] = useState(issue.subscribed);
  if (was !== issue.subscribed) {
    setWas(issue.subscribed);
    setOn(issue.subscribed);
  }
  if (!L.canComment && !on) return null;
  return (
    <IconButton
      label={on ? t("i.unsubscribe") : t("i.subscribe")}
      active={on}
      onClick={() => {
        setOn(!on);
        void api(`issues/${issue.id}/subscribe`, { method: "POST", body: { on: !on } })
          .then(() => invalidateAll())
          .catch((e) => {
            setOn(on);
            toast(errorText(e, t), "error");
          });
      }}
    >
      {on ? <Bell size={15} /> : <BellOff size={15} />}
    </IconButton>
  );
}

function TitleField({ issue, canEdit, onSave }: { issue: Issue; canEdit: boolean; onSave: (v: string) => void }) {
  const { t } = useT();
  const [v, setV] = useState(issue.title);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (document.activeElement !== ref.current) setV(issue.title);
  }, [issue.title]);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = "0px";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [v]);
  const commit = () => {
    const s = v.replace(/\s+/g, " ").trim();
    if (!s) setV(issue.title);
    else if (s !== issue.title) onSave(s);
  };
  return (
    <textarea
      ref={ref}
      className="pj-issue-title"
      value={v}
      readOnly={!canEdit}
      rows={1}
      aria-label={t("i.title")}
      maxLength={300}
      onChange={(e) => setV(e.target.value.replace(/\n/g, " "))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
        if (e.key === "Escape") {
          setV(issue.title);
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
    />
  );
}

// --- Properties ------------------------------------------------------------------

function PropRow({ label, kind, issue, canEdit, children }: { label: string; kind: PropKind | null; issue: Issue; canEdit: boolean; children: ReactNode }) {
  const pop = usePopover();
  return (
    <div className="pj-prop-row">
      <span className="pj-prop-label">{label}</span>
      {kind && canEdit ? (
        <button type="button" className="pj-prop-value" onClick={(e) => pop.toggle(e.currentTarget)}>
          <span className="pj-sr">{label}: </span>
          {children}
        </button>
      ) : (
        <span className="pj-prop-value" data-static="">
          {children}
        </span>
      )}
      {pop.anchor && kind && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={kind === "due" ? 268 : 250} label={label}>
          <PropPicker kind={kind} issues={[issue]} onClose={pop.close} />
        </Popover>
      )}
    </div>
  );
}

export function propertyValues(issue: Issue, L: Lookups, t: PT, f: ReturnType<typeof useFormat>) {
  const s = L.status.get(issue.statusId);
  const p = issue.assigneeId ? L.person.get(issue.assigneeId) : null;
  const project = issue.projectId ? L.project.get(issue.projectId) : null;
  const cycle = issue.cycleId ? L.cycle.get(issue.cycleId) : null;
  const team = L.team.get(issue.teamId);
  const milestone = project?.milestones.find((m) => m.id === issue.milestoneId);
  return {
    status: (
      <>
        {s && <StatusIcon category={s.category} color={s.color} fraction={L.fraction(s.id)} />}
        <span>{s?.name ?? "—"}</span>
      </>
    ),
    priority: (
      <>
        <PriorityIcon priority={issue.priority} />
        <span>{t(`prio.${issue.priority}`)}</span>
      </>
    ),
    assignee: (
      <>
        {issue.assigneeId ? <Avatar name={p?.name ?? "?"} id={issue.assigneeId} size={18} src={p?.avatar} faded={!p?.role} /> : <UnassignedIcon size={18} />}
        <span>{personName(L, issue.assigneeId, t)}</span>
      </>
    ),
    labels: issue.labelIds.length ? (
      <span className="pj-labels pj-labels-wrap">
        {issue.labelIds.map((id) => {
          const l = L.label.get(id);
          return l ? (
            <span className="pj-label-pill" key={id}>
              <span className="pj-dot" style={{ background: uiColor(l.color) }} />
              {l.name}
            </span>
          ) : null;
        })}
      </span>
    ) : (
      <span className="pj-muted">{t("i.noLabels")}</span>
    ),
    project: project ? (
      <>
        <ProjectGlyph icon={project.icon} color={project.color} />
        <span>{project.name}</span>
      </>
    ) : (
      <span className="pj-muted">{t("i.noProject")}</span>
    ),
    milestone: milestone ? <span>◆ {milestone.name}</span> : <span className="pj-muted">{t("i.noMilestone")}</span>,
    cycle: cycle ? (
      <>
        <CycleGlyph progress={cycle.progress.total ? cycle.progress.completed / cycle.progress.total : 0} />
        <span>{cycle.name || t("cy.name", { n: cycle.number })}</span>
      </>
    ) : (
      <span className="pj-muted">{t("i.noCycle")}</span>
    ),
    estimate: issue.estimate !== null && team ? <span>{estimateLabel(team.estimates, issue.estimate)}</span> : <span className="pj-muted">{t("i.noEstimate")}</span>,
    due: issue.dueDate ? <span className={issue.dueDate < L.b.today && s?.category !== "completed" && s?.category !== "canceled" ? "pj-overdue" : ""}>{f.day(issue.dueDate)}</span> : <span className="pj-muted">{t("i.noDue")}</span>,
    team: team ? (
      <>
        <Glyph icon={team.icon} color={team.color} text={team.name} size={16} />
        <span>{team.name}</span>
      </>
    ) : (
      <span>—</span>
    ),
  };
}

function Properties({ issue, canEdit }: { issue: Detail; canEdit: boolean }) {
  const { t } = useT();
  const L = useLookups();
  const f = useFormat();
  const v = propertyValues(issue, L, t, f);
  const team = L.team.get(issue.teamId);
  const fields = L.b.fields.filter((x) => !x.teamId || x.teamId === issue.teamId);
  const creator = issue.creatorId ? L.person.get(issue.creatorId) : null;
  return (
    <div className="pj-props">
      <PropRow label={t("f.status")} kind="status" issue={issue} canEdit={canEdit}>
        {v.status}
      </PropRow>
      <PropRow label={t("f.priority")} kind="priority" issue={issue} canEdit={canEdit}>
        {v.priority}
      </PropRow>
      <PropRow label={t("f.assignee")} kind="assignee" issue={issue} canEdit={canEdit}>
        {v.assignee}
      </PropRow>
      {canEdit && issue.assigneeId !== L.b.me.id && (
        <button type="button" className="pj-link pj-small pj-assign-me" onClick={() => void saveIssue(issue.id, { assigneeId: L.b.me.id }, { assigneeId: L.b.me.id })}>
          {t("i.assignMe")}
        </button>
      )}
      <PropRow label={t("f.labels")} kind="labels" issue={issue} canEdit={canEdit}>
        {v.labels}
      </PropRow>
      <PropRow label={t("f.project")} kind="project" issue={issue} canEdit={canEdit}>
        {v.project}
      </PropRow>
      {issue.projectId && (L.project.get(issue.projectId)?.milestones.length ?? 0) > 0 && (
        <PropRow label={t("p.milestone")} kind="milestone" issue={issue} canEdit={canEdit}>
          {v.milestone}
        </PropRow>
      )}
      {team?.cyclesEnabled && (
        <PropRow label={t("f.cycle")} kind="cycle" issue={issue} canEdit={canEdit}>
          {v.cycle}
        </PropRow>
      )}
      {team && team.estimates !== "none" && (
        <PropRow label={t("p.estimate")} kind="estimate" issue={issue} canEdit={canEdit}>
          {v.estimate}
        </PropRow>
      )}
      <PropRow label={t("f.due")} kind="due" issue={issue} canEdit={canEdit}>
        {v.due}
      </PropRow>
      <PropRow label={t("f.team")} kind="team" issue={issue} canEdit={canEdit}>
        {v.team}
      </PropRow>
      {fields.length > 0 && (
        <>
          <div className="pj-props-sub">{t("i.fields")}</div>
          {fields.map((fd) => (
            <FieldRow key={fd.id} field={fd} issue={issue} canEdit={canEdit} />
          ))}
        </>
      )}
      <div className="pj-props-foot">
        <div>
          {t("f.creator")}: {creator?.name ?? t("act.former")}
        </div>
        <div>
          {t("p.created")}: {f.dateTime(issue.createdAt)}
        </div>
        <div>
          {t("p.updated")}: {f.ago(issue.updatedAt)}
        </div>
      </div>
    </div>
  );
}

/** In the side panel: the properties as one row of zvena Pills above the details; an empty one reads "+ Due". */
function PropertyStrip({ issue, canEdit }: { issue: Detail; canEdit: boolean }) {
  const { t } = useT();
  const L = useLookups();
  const f = useFormat();
  const s = L.status.get(issue.statusId);
  const person = issue.assigneeId ? L.person.get(issue.assigneeId) : null;
  const project = issue.projectId ? L.project.get(issue.projectId) : null;
  const cycle = issue.cycleId ? L.cycle.get(issue.cycleId) : null;
  const team = L.team.get(issue.teamId);
  const labels = issue.labelIds.map((id) => L.label.get(id)).filter((x) => !!x);
  const open = s?.category !== "completed" && s?.category !== "canceled";
  const pill = (kind: PropKind, label: string, filled: boolean, icon: ReactNode, text: ReactNode, extra: { dot?: string; late?: boolean } = {}) => (
    <PropPill key={kind} kind={kind} issue={issue} canEdit={canEdit} icon={filled ? icon : <Plus />} dot={extra.dot} tone={!filled ? "empty" : extra.late ? "late" : "default"} title={label}>
      {filled ? text : label}
    </PropPill>
  );
  return (
    <div className="pj-prop-strip">
      {pill("status", t("f.status"), true, s ? <StatusIcon category={s.category} color={s.color} fraction={L.fraction(s.id)} /> : null, s?.name ?? "—")}
      {pill("priority", t("f.priority"), true, <PriorityIcon priority={issue.priority} />, t(`prio.${issue.priority}`))}
      {pill("assignee", t("f.assignee"), !!issue.assigneeId, <Avatar name={person?.name ?? "?"} id={issue.assigneeId ?? ""} size={16} src={person?.avatar} faded={!person?.role} />, personName(L, issue.assigneeId, t))}
      {pill("labels", t("f.labels"), labels.length > 0, null, labels.map((l) => l.name).join(", "), { dot: labels[0] ? uiColor(labels[0].color) : undefined })}
      {pill("project", t("f.project"), !!project, project ? <ProjectGlyph icon={project.icon} color={project.color} size={14} /> : null, project?.name)}
      {team?.cyclesEnabled && pill("cycle", t("f.cycle"), !!cycle, <CycleGlyph size={14} progress={cycle && cycle.progress.total ? cycle.progress.completed / cycle.progress.total : 0} />, cycle ? cycle.name || t("cy.name", { n: cycle.number }) : "")}
      {team && team.estimates !== "none" && pill("estimate", t("p.estimate"), issue.estimate !== null, <Gauge />, issue.estimate !== null ? estimateLabel(team.estimates, issue.estimate) : "")}
      {pill("due", t("f.due"), !!issue.dueDate, <CalendarDays />, issue.dueDate ? dueWord(issue.dueDate, L.b.today, t, f.day) : "", { late: !!issue.dueDate && open && issue.dueDate < L.b.today })}
    </div>
  );
}

function FieldRow({ field, issue, canEdit }: { field: CustomField; issue: Detail; canEdit: boolean }) {
  const { t } = useT();
  const value = issue.fields[field.id] ?? "";
  const [v, setV] = useState(value);
  const [was, setWas] = useState(value);
  if (was !== value) {
    setWas(value);
    setV(value);
  }
  const save = (next: string | boolean | null) =>
    void api(`issues/${issue.id}`, { method: "PATCH", body: { fields: { [field.id]: next } } })
      .then(() => invalidateAll())
      .catch((e) => {
        setV(value);
        toast(errorText(e, t), "error");
      });
  let input: ReactNode;
  if (field.type === "checkbox") input = <input type="checkbox" checked={value === "true"} disabled={!canEdit} onChange={(e) => save(e.target.checked)} aria-label={field.name} />;
  else if (field.type === "select")
    input = (
      <select className="pj-select pj-select-sm" value={value} disabled={!canEdit} onChange={(e) => save(e.target.value || null)} aria-label={field.name}>
        <option value="">—</option>
        {field.options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    );
  else if (field.type === "url" && !canEdit)
    input = value ? (
      <a href={value} target="_blank" rel="noopener noreferrer nofollow">
        {value}
      </a>
    ) : (
      <span className="pj-muted">—</span>
    );
  else
    input = (
      <input
        className="pj-input pj-input-sm"
        type={field.type === "number" ? "number" : field.type === "date" ? "date" : field.type === "url" ? "url" : "text"}
        value={v}
        readOnly={!canEdit}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => v !== value && save(v || null)}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        aria-label={field.name}
        placeholder="—"
      />
    );
  return (
    <div className="pj-prop-row">
      <span className="pj-prop-label">{field.name}</span>
      <span className="pj-prop-value" data-static="">
        {input}
      </span>
    </div>
  );
}

// --- Sub-issues ------------------------------------------------------------------

function SubIssues({ issue, canEdit }: { issue: Detail; canEdit: boolean }) {
  const { t } = useT();
  const L = useLookups();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const done = issue.children.filter((c) => {
    const s = L.status.get(c.statusId);
    return s?.category === "completed" || s?.category === "canceled";
  }).length;
  const started = issue.children.filter((c) => L.status.get(c.statusId)?.category === "started").length;
  const create = async () => {
    if (!title.trim()) return;
    try {
      await api("issues", { method: "POST", body: { teamId: issue.teamId, title, parentId: issue.id, projectId: issue.projectId ?? undefined, cycleId: issue.cycleId ?? undefined } });
      setTitle("");
      invalidateAll();
    } catch (e) {
      toast(errorText(e, t), "error");
    }
  };
  if (!issue.children.length && !canEdit) return null;
  return (
    <section className="pj-section">
      <div className="pj-section-head">
        <h2>
          {t("i.subIssues")}
          {issue.children.length > 0 && (
            <span className="pj-group-count">
              {done}/{issue.children.length}
            </span>
          )}
        </h2>
        {canEdit && (
          <button type="button" className="pj-btn pj-btn-sm pj-btn-ghost" onClick={() => setAdding(true)}>
            <Plus size={14} />
            {t("i.addSub")}
          </button>
        )}
      </div>
      {issue.children.length > 0 && (
        <div className="pj-mini-progress">
          <span style={{ width: `${(done / issue.children.length) * 100}%` }} />
          {started > 0 && <span className="pj-progress-started" style={{ width: `${(started / issue.children.length) * 100}%` }} />}
        </div>
      )}
      <div className="pj-sublist">
        {issue.children.map((c) => (
          <MiniRow key={c.id} issue={c} sub={canEdit ? c : undefined} />
        ))}
      </div>
      {adding && (
        <form
          className="pj-inline-add"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input
            className="pj-input pj-input-sm"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("i.subTitle")}
            aria-label={t("i.subTitle")}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setAdding(false);
              }
            }}
          />
          <button type="submit" className="pj-btn pj-btn-sm pj-btn-primary" disabled={!title.trim()}>
            {t("c.add")}
          </button>
        </form>
      )}
    </section>
  );
}

/** A short line for another issue; `sub`: a sub-issue whose status can be changed right there (Linear's sub-issue list). */
export function MiniRow({ issue, right, sub }: { issue: { id: string; identifier: string; title: string; statusId: string; assigneeId?: string | null }; right?: ReactNode; sub?: Issue }) {
  const L = useLookups();
  const { t } = useT();
  const s = L.status.get(issue.statusId);
  const p = issue.assigneeId ? L.person.get(issue.assigneeId) : null;
  const icon = s && <StatusIcon category={s.category} color={s.color} fraction={L.fraction(s.id)} />;
  return (
    <div className="pj-mini-row">
      {sub && s ? (
        <PropButton kind="status" issue={sub} label={`${t("f.status")}: ${s.name}`} className="pj-mini-status">
          {icon}
        </PropButton>
      ) : (
        icon
      )}
      <span className="pj-row-id">{issue.identifier}</span>
      <Link to={`/issue/${issue.identifier}`} className="pj-mini-title">
        {issue.title}
      </Link>
      {issue.assigneeId && <Avatar name={p?.name ?? "?"} id={issue.assigneeId} size={18} src={p?.avatar} />}
      {right}
    </div>
  );
}

// --- Relations -------------------------------------------------------------------

const REL_ICON: Record<RelationType, ReactNode> = {
  blocks: <OctagonAlert size={13} className="pj-blocking" />,
  blocked_by: <Ban size={13} className="pj-blocked" />,
  related: <Link2 size={13} />,
  duplicate: <Copy size={13} />,
  duplicated_by: <Copy size={13} />,
};

function Relations({ issue, canEdit }: { issue: Detail; canEdit: boolean }) {
  const { t } = useT();
  const pop = usePopover();
  const [type, setType] = useState<RelationType | null>(null);
  const remove = (id: string) =>
    void api(`relations/${id}`, { method: "DELETE" })
      .then(() => invalidateAll())
      .catch((e) => toast(errorText(e, t), "error"));
  if (!issue.relations.length && !canEdit) return null;
  const order: RelationType[] = ["blocked_by", "blocks", "related", "duplicate", "duplicated_by"];
  return (
    <section className="pj-section">
      <div className="pj-section-head">
        <h2>{t("i.relations")}</h2>
        {canEdit && (
          <button
            type="button"
            className="pj-btn pj-btn-sm pj-btn-ghost"
            onClick={(e) => {
              setType(null);
              pop.toggle(e.currentTarget);
            }}
          >
            <Plus size={14} />
            {t("i.addRelation")}
          </button>
        )}
      </div>
      {order.map((ty) => {
        const list = issue.relations.filter((r) => r.type === ty);
        if (!list.length) return null;
        return (
          <div key={ty} className="pj-rel-group">
            <div className="pj-rel-type">
              {REL_ICON[ty]}
              {t(`rel.${ty}`)}
            </div>
            {list.map((r) => (
              <MiniRow
                key={r.id}
                issue={r.issue}
                right={
                  canEdit && (
                    <button type="button" className="pj-icon-btn pj-icon-xs" aria-label={t("c.delete")} onClick={() => remove(r.id)}>
                      <X size={13} />
                    </button>
                  )
                }
              />
            ))}
          </div>
        );
      })}
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={320} label={t("i.addRelation")}>
          {type ? (
            <IssueSearch
              exclude={[issue.id, ...issue.relations.map((r) => r.issue.id)]}
              onPick={(other) => {
                pop.close();
                void api(`issues/${issue.id}/relations`, { method: "POST", body: { type, relatedId: other.id } })
                  .then(() => invalidateAll())
                  .catch((e) => toast(errorText(e, t), "error"));
              }}
              onClose={pop.close}
            />
          ) : (
            <Menu
              search={false}
              onClose={pop.close}
              items={(["blocked_by", "blocks", "related", "duplicate"] as const).map((ty) => ({ id: ty, label: t(`rel.${ty}`), icon: REL_ICON[ty], keepOpen: true, onSelect: () => setType(ty) }))}
            />
          )}
        </Popover>
      )}
    </section>
  );
}

// --- Attachments ---------------------------------------------------------------

function Attachments({ issue, canEdit }: { issue: Detail; canEdit: boolean }) {
  const { t } = useT();
  const L = useLookups();
  const f = useFormat();
  if (!issue.attachmentList.length) return null;
  return (
    <div className="pj-attachments">
      {issue.attachmentList.map((a) => (
        <div key={a.id} className="pj-attachment">
          {a.image ? (
            <a href={a.url} target="_blank" rel="noopener noreferrer" className="pj-att-thumb">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={a.url} alt={a.name} loading="lazy" />
            </a>
          ) : (
            <span className="pj-att-icon">
              <FileText size={18} />
            </span>
          )}
          <div className="pj-att-main">
            <a href={a.url} target="_blank" rel="noopener noreferrer" className="pj-att-name">
              {a.name}
            </a>
            <div className="pj-small pj-muted">
              {bytes(a.bytes)} · {L.person.get(a.uploadedBy ?? "")?.name ?? ""} · {f.ago(a.createdAt)}
            </div>
          </div>
          <a className="pj-icon-btn" href={`${a.url}?download=1`} aria-label={t("a11y.download")} title={t("a11y.download")}>
            <Download size={14} />
          </a>
          <button
            type="button"
            className="pj-icon-btn"
            aria-label={t("i.signedLink")}
            title={t("i.signedLink")}
            onClick={() =>
              void api<{ url: string }>(`attachments/${a.id}/link`, { method: "POST", body: {} })
                .then((r) => copy(`${location.origin}${r.url}`, t))
                .catch((e) => toast(errorText(e, t), "error"))
            }
          >
            <ExternalLink size={14} />
          </button>
          {canEdit && (
            <button
              type="button"
              className="pj-icon-btn"
              aria-label={t("c.delete")}
              title={t("c.delete")}
              onClick={() =>
                void api(`attachments/${a.id}`, { method: "DELETE" })
                  .then(() => invalidateAll())
                  .catch((e) => toast(errorText(e, t), "error"))
              }
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// --- Timeline: history and comments --------------------------------------------

type Entry = { kind: "activity"; at: number; a: Activity } | { kind: "comment"; at: number; c: Comment; replies: Comment[] };

function Timeline({ issue }: { issue: Detail }) {
  const { t } = useT();
  const L = useLookups();
  const entries = useMemo<Entry[]>(() => {
    const roots = issue.comments_.filter((c) => !c.parentId);
    const replies = (id: string) => issue.comments_.filter((c) => c.parentId === id);
    const list: Entry[] = [
      ...issue.activity.filter((a) => a.kind !== "comment").map((a) => ({ kind: "activity" as const, at: a.createdAt, a })),
      ...roots.map((c) => ({ kind: "comment" as const, at: c.createdAt, c, replies: replies(c.id) })),
    ];
    return list.sort((x, y) => x.at - y.at);
  }, [issue.activity, issue.comments_]);
  return (
    <section className="pj-section pj-timeline">
      <div className="pj-section-head">
        <h2>{t("i.activity")}</h2>
      </div>
      <ol className="pj-tl">
        {entries.map((e) => (e.kind === "activity" ? <ActivityLine key={`a${e.a.id}`} a={e.a} /> : <CommentBlock key={e.c.id} issue={issue} c={e.c} replies={e.replies} />))}
      </ol>
      {L.canComment && !issue.archivedAt && <Composer issue={issue} />}
    </section>
  );
}

function ActivityLine({ a }: { a: Activity }) {
  const { t } = useT();
  const L = useLookups();
  const f = useFormat();
  const actor = a.actorId ? (L.person.get(a.actorId)?.name ?? t("act.former")) : t("act.someone");
  const person = (id: unknown) => (typeof id === "string" ? (L.person.get(id)?.name ?? t("act.former")) : "");
  const status = (id: unknown) => (typeof id === "string" ? (L.status.get(id)?.name ?? "—") : "—");
  const project = (id: unknown) => (typeof id === "string" ? (L.project.get(id)?.name ?? "—") : "");
  const cycle = (id: unknown) => {
    const c = typeof id === "string" ? L.cycle.get(id) : null;
    return c ? c.name || t("cy.name", { n: c.number }) : "—";
  };
  const labels = (v: unknown) => (Array.isArray(v) ? v.map((id) => L.label.get(String(id))?.name ?? "?").join(", ") : "");
  let text: string;
  let icon: ReactNode = <span className="pj-tl-dot" />;
  switch (a.kind) {
    case "created":
      text = t("act.created");
      break;
    case "title":
      text = t("act.title");
      break;
    case "description":
      text = t("act.description");
      break;
    case "status": {
      text = t("act.status", { from: status(a.from), to: status(a.to) });
      const s = typeof a.to === "string" ? L.status.get(a.to) : null;
      if (s) icon = <StatusIcon category={s.category} color={s.color} fraction={L.fraction(s.id)} size={12} />;
      break;
    }
    case "priority":
      text = t("act.priority", { from: t(`prio.${Number(a.from) as 0}`), to: t(`prio.${Number(a.to) as 0}`) });
      icon = <PriorityIcon priority={Number(a.to) as 0} size={13} />;
      break;
    case "assignee":
      text = a.to ? t("act.assignee.set", { to: person(a.to) }) : t("act.assignee.unset", { from: person(a.from) });
      break;
    case "project":
      text = a.to ? t("act.project.set", { to: project(a.to) }) : t("act.project.unset", { from: project(a.from) });
      break;
    case "cycle":
      text = a.to ? t("act.cycle.set", { to: cycle(a.to) }) : t("act.cycle.unset");
      break;
    case "milestone":
      text = t("act.milestone");
      break;
    case "parent":
      text = a.to ? t("act.parent.set", { to: String((a.to as { identifier?: string } | null)?.identifier ?? "") }) : t("act.parent.unset");
      break;
    case "due":
      text = a.to ? t("act.due.set", { to: f.day(String(a.to)) }) : t("act.due.unset");
      break;
    case "estimate":
      text = t("act.estimate", { from: a.from === null ? "—" : String(a.from), to: a.to === null ? "—" : String(a.to) });
      break;
    case "labels": {
      const add = labels(a.to);
      const rem = labels(a.from);
      text = [add && t("act.labels.add", { to: add }), rem && t("act.labels.remove", { from: rem })].filter(Boolean).join("; ");
      break;
    }
    case "team":
      text = t("act.team");
      break;
    case "archived":
    case "unarchived":
      text = t(`act.${a.kind}`);
      break;
    case "relation": {
      const v = a.to as { type?: RelationType; identifier?: string } | null;
      text = t("act.relation", { type: v?.type ? t(`rel.${v.type}`) : "", to: v?.identifier ?? "" });
      break;
    }
    case "relation_removed":
      text = t("act.relation_removed", { from: (a.from as { identifier?: string } | null)?.identifier ?? "" });
      break;
    case "triage":
      text = t("act.triage");
      break;
    case "triaged":
      text = t(a.to === "declined" ? "act.triaged.declined" : a.to === "duplicate" ? "act.triaged.duplicate" : "act.triaged.accepted");
      break;
    case "triage_snoozed":
      text = t("act.triage_snoozed", { date: typeof a.to === "number" ? f.dateTime(a.to) : "" });
      break;
    case "attachment":
      text = t("act.attachment", { to: String((a.to as { name?: string } | null)?.name ?? "") });
      break;
    case "attachment_removed":
      text = t("act.attachment_removed", { from: String((a.from as { name?: string } | null)?.name ?? "") });
      break;
    case "field": {
      const fid = (a.to as { field?: string } | null)?.field;
      text = t("act.field", { field: (fid && L.field.get(fid)?.name) || "" });
      break;
    }
    default:
      text = a.kind;
  }
  return (
    <li className="pj-tl-act">
      <span className="pj-tl-icon">{icon}</span>
      <span>
        {a.via === "auto" ? (
          <>
            <b className="pj-auto-name">{t("act.autoName")}</b> <span className="pj-muted">{t("act.autoFor", { name: actor })}</span> {text}
          </>
        ) : (
          <>
            <b>{actor}</b> {text}
          </>
        )}
      </span>
      <time className="pj-tl-time" title={f.dateTime(a.createdAt)}>
        {f.ago(a.createdAt)}
      </time>
    </li>
  );
}

const REACTIONS = ["👍", "❤️", "🎉", "🚀", "👀", "😄"];

function CommentBlock({ issue, c, replies }: { issue: Detail; c: Comment; replies: Comment[] }) {
  const [replying, setReplying] = useState(false);
  return (
    <li className="pj-tl-comment">
      <CommentCard c={c} onReply={() => setReplying(true)} />
      {replies.map((r) => (
        <div key={r.id} className="pj-reply">
          <CommentCard c={r} onReply={() => setReplying(true)} />
        </div>
      ))}
      {replying && (
        <div className="pj-reply">
          <Composer issue={issue} parentId={c.id} onDone={() => setReplying(false)} autofocus />
        </div>
      )}
    </li>
  );
}

function CommentCard({ c, onReply }: { c: Comment; onReply: () => void }) {
  const { t } = useT();
  const L = useLookups();
  const f = useFormat();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.body);
  const emoji = usePopover();
  const author = c.authorId ? L.person.get(c.authorId) : null;
  const mine = c.authorId === L.b.me.id;
  const react = (e: string) =>
    void api(`comments/${c.id}/reactions`, { method: "POST", body: { emoji: e } })
      .then(() => invalidateAll())
      .catch((err) => toast(errorText(err, t), "error"));
  return (
    <div className="pj-comment" id={`comment-${c.id}`}>
      <div className="pj-comment-head">
        <Avatar name={author?.name ?? "?"} id={c.authorId} size={20} src={author?.avatar} />
        <b>{author?.name ?? t("act.former")}</b>
        <time className="pj-tl-time" title={f.dateTime(c.createdAt)}>
          {f.ago(c.createdAt)}
          {c.editedAt ? ` · ${t("i.edited")}` : ""}
        </time>
        <span className="pj-comment-actions">
          {L.canComment && (
            <>
              <button type="button" className="pj-icon-btn pj-icon-xs" aria-label={t("a11y.emoji")} onClick={(e) => emoji.toggle(e.currentTarget)}>
                <Smile size={14} />
              </button>
              <button type="button" className="pj-link pj-small" onClick={onReply}>
                {t("i.reply")}
              </button>
            </>
          )}
          {mine && !editing && (
            <button type="button" className="pj-link pj-small" onClick={() => setEditing(true)}>
              {t("i.edit")}
            </button>
          )}
          {(mine || L.isOwner) && (
            <button
              type="button"
              className="pj-icon-btn pj-icon-xs"
              aria-label={t("c.delete")}
              onClick={() =>
                void api(`comments/${c.id}`, { method: "DELETE" })
                  .then(() => invalidateAll())
                  .catch((e) => toast(errorText(e, t), "error"))
              }
            >
              <Trash2 size={13} />
            </button>
          )}
        </span>
      </div>
      {editing ? (
        <div className="pj-comment-edit">
          <MarkdownEditor value={c.body} onChange={setDraft} people={L.b.people} autofocus onSubmit={(md) => void saveEdit(md)} />
          <div className="pj-row-end">
            <button type="button" className="pj-btn pj-btn-sm" onClick={() => setEditing(false)}>
              {t("c.cancel")}
            </button>
            <button type="button" className="pj-btn pj-btn-sm pj-btn-primary" onClick={() => void saveEdit(draft)}>
              {t("c.save")}
            </button>
          </div>
        </div>
      ) : (
        <MarkdownView value={c.body} className="pj-comment-body" />
      )}
      {c.reactions.length > 0 && (
        <div className="pj-reactions">
          {c.reactions.map((r) => (
            <button
              key={r.emoji}
              type="button"
              className="pj-reaction"
              data-mine={r.userIds.includes(L.b.me.id) || undefined}
              title={r.userIds.map((u) => L.person.get(u)?.name ?? "?").join(", ")}
              onClick={() => L.canComment && react(r.emoji)}
            >
              {r.emoji} {r.userIds.length}
            </button>
          ))}
        </div>
      )}
      {emoji.anchor && (
        <Popover anchor={emoji.anchor} onClose={emoji.close} label={t("a11y.emoji")}>
          <div className="pj-emoji-row">
            {REACTIONS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => {
                  emoji.close();
                  react(e);
                }}
              >
                {e}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </div>
  );

  async function saveEdit(md: string) {
    if (!md.trim()) return;
    try {
      await api(`comments/${c.id}`, { method: "PATCH", body: { body: md } });
      setEditing(false);
      invalidateAll();
    } catch (e) {
      toast(errorText(e, t), "error");
    }
  }
}

function Composer({ issue, parentId, onDone, autofocus }: { issue: Detail; parentId?: string; onDone?: () => void; autofocus?: boolean }) {
  const { t } = useT();
  useKeyboardInset();
  const L = useLookups();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(0);
  const me = L.person.get(L.b.me.id);
  const send = async (md: string) => {
    if (!md.trim() || busy) return;
    setBusy(true);
    try {
      await api(`issues/${issue.id}/comments`, { method: "POST", body: { body: md, parentId } });
      setDraft("");
      setKey((k) => k + 1);
      patchCachedIssue(issue.id, { comments: issue.comments + 1 });
      invalidateAll();
      onDone?.();
    } catch (e) {
      toast(errorText(e, t), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pj-composer">
      <Avatar name={me?.name ?? L.b.me.name} id={L.b.me.id} size={22} src={me?.avatar} />
      <div className="pj-composer-box">
        <MarkdownEditor key={key} value="" onChange={setDraft} onSubmit={(md) => void send(md)} placeholder={t("i.comment")} people={L.b.people} autofocus={autofocus} label={t("i.comment")} />
        <div className="pj-composer-foot">
          <span className="pj-small pj-muted">
            <kbd className="pj-kbd">{typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘" : "Ctrl"}</kbd>+<kbd className="pj-kbd">Enter</kbd>
          </span>
          {onDone && (
            <button type="button" className="pj-btn pj-btn-sm" onClick={onDone}>
              {t("c.cancel")}
            </button>
          )}
          <button type="button" className="pj-btn pj-btn-sm pj-btn-primary" disabled={busy || !draft.trim()} onClick={() => void send(draft)}>
            {parentId ? t("i.reply") : t("i.send")}
          </button>
        </div>
      </div>
    </div>
  );
}

