"use client";

// The "New issue" dialog (C anywhere): team, title, rich description and
// property pills, "create more", Ctrl/Cmd+Enter to create. The draft
// survives closing the dialog by accident (kept in this browser only).

import { useEffect, useState, type ReactNode } from "react";
import { Box, CalendarDays, ChevronRight, Gauge, GitBranch, RefreshCcw, Tag, X } from "lucide-react";
import { estimateLabel, type Issue, type Priority } from "@/lib/projects/types";
import { closeCreate, remember, type CreateDefaults } from "./app-state";
import { api, errorText, invalidateAll, loadBoot, toast, useLookups, workspaceId } from "./data";
import { DescribeButton } from "./Assistant";
import { MarkdownEditor } from "./Editor";
import { CycleGlyph, Glyph, PriorityIcon, ProjectGlyph, StatusIcon, uiColor } from "./icons";
import { useT } from "./i18n";
import { AssigneePicker, CyclePicker, EstimatePicker, LabelPicker, PriorityPicker, ProjectPicker, StatusPicker, TeamPicker } from "./pickers";
import { href, navigate } from "./router";
import { Pill } from "@/components/zvena/ds";
import { Avatar, DatePicker, Modal, Popover, Toggle, UnassignedIcon, modKey, useFormat, usePopover } from "./ui";
import { useKeyboardInset } from "./keyboard";

interface Draft {
  teamId: string;
  title: string;
  description: string;
  statusId: string | null;
  priority: Priority;
  assigneeId: string | null;
  projectId: string | null;
  cycleId: string | null;
  labelIds: string[];
  dueDate: string | null;
  estimate: number | null;
  parentId: string | null;
  milestoneId: string | null;
}

export function CreateIssueDialog({ defaults }: { defaults: CreateDefaults }) {
  const { t } = useT();
  useKeyboardInset();
  const L = useLookups();
  const f = useFormat();
  const firstTeam = L.b.teams.find((x) => x.isMember && !x.archivedAt) ?? L.b.teams.find((x) => !x.archivedAt);
  const saved = remember<Draft>("draft");
  const [d, setD] = useState<Draft>(() => {
    const teamId = defaults.teamId && L.team.has(defaults.teamId) ? defaults.teamId : (saved?.teamId && L.team.has(saved.teamId) ? saved.teamId : firstTeam?.id) ?? "";
    const fromDraft = !defaults.title && !defaults.parentId && saved && saved.teamId === teamId && (saved.title || saved.description);
    return {
      teamId,
      title: defaults.title ?? (fromDraft ? saved.title : ""),
      description: defaults.description ?? (fromDraft ? saved.description : ""),
      statusId: defaults.statusId ?? null,
      priority: (defaults.priority as Priority | undefined) ?? 0,
      assigneeId: defaults.assigneeId ?? null,
      projectId: defaults.projectId ?? null,
      cycleId: defaults.cycleId ?? null,
      labelIds: defaults.labelIds ?? [],
      dueDate: defaults.dueDate ?? null,
      estimate: defaults.estimate ?? null,
      parentId: defaults.parentId ?? null,
      milestoneId: defaults.milestoneId ?? null,
    };
  });
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const team = L.team.get(d.teamId);
  const statuses = L.statusesOf(d.teamId);
  const status = (d.statusId && L.status.get(d.statusId)) || statuses.find((s) => s.category === "unstarted") || statuses[0];

  useEffect(() => {
    remember("draft", { ...d, title: d.title, description: d.description });
  }, [d]);

  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const changeTeam = (teamId: string) => {
    // Team-only properties do not travel to another team.
    set({ teamId, statusId: null, cycleId: null, estimate: null, labelIds: d.labelIds.filter((l) => !L.label.get(l)?.teamId || L.label.get(l)?.teamId === teamId) });
  };

  const submit = async () => {
    if (!d.title.trim() || busy || !team) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = { teamId: d.teamId, title: d.title, description: d.description, priority: d.priority, labelIds: d.labelIds };
      if (status) body.statusId = status.id;
      for (const k of ["assigneeId", "projectId", "cycleId", "dueDate", "estimate", "parentId", "milestoneId"] as const) if (d[k] !== null) body[k] = d[k];
      const it = await api<Issue>("issues", { method: "POST", body });
      // Created from elsewhere in zvena (a document, a design…): link the two.
      if (defaults.linkFor)
        void fetch(`/api/eco/link?ws=${encodeURIComponent(workspaceId())}`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ src: defaults.linkFor, dst: `issue:${it.id}` }),
        }).catch(() => undefined);
      invalidateAll();
      void loadBoot();
      toast(t(it.triage ? "tr.sent" : "i.created", { id: it.identifier }), "success", { label: t("i.open"), run: () => navigate(`/issue/${it.identifier}`) });
      remember("draft", {});
      if (more) {
        set({ title: "", description: "" });
        setEditorKey((k) => k + 1);
      } else closeCreate();
    } catch (e) {
      toast(errorText(e, t), "error");
    } finally {
      setBusy(false);
    }
  };

  const parent = d.parentId ? defaults.parentId : null;
  const assignee = d.assigneeId ? L.person.get(d.assigneeId) : null;
  const project = d.projectId ? L.project.get(d.projectId) : null;
  const cycle = d.cycleId ? L.cycle.get(d.cycleId) : null;
  const labels = d.labelIds.map((id) => L.label.get(id)).filter(Boolean);

  return (
    <Modal onClose={closeCreate} label={t("nav.newIssue")} width={720} className="pj-create">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <div className="pj-create-head">
          <CreatePill
            label={t("f.team")}
            icon={team ? <Glyph icon={team.icon} color={team.color} text={team.name} size={16} /> : null}
            text={team?.key ?? "—"}
            picker={(close) => <TeamPicker value={d.teamId} onClose={close} onPick={changeTeam} />}
          />
          <ChevronRight size={14} className="pj-muted-icon" />
          <span className="pj-small pj-muted">{t("nav.newIssue")}</span>
          {parent && (
            <span className="pj-tag">
              <GitBranch size={12} /> {t("i.parent")}
            </span>
          )}
          <span className="pj-create-head-end">
            <DescribeButton onUse={(r) => {
              set({ title: d.title || r.title, description: r.description });
              setEditorKey((k) => k + 1);
            }} />
            <button type="button" className="pj-icon-btn" aria-label={t("c.close")} onClick={closeCreate}>
              <X size={16} />
            </button>
          </span>
        </div>
        <input className="pj-create-title" autoFocus value={d.title} onChange={(e) => set({ title: e.target.value })} placeholder={t("i.title")} aria-label={t("i.title")} maxLength={300} />
        <SimilarIssues title={d.title} description={d.description} />
        <MarkdownEditor key={editorKey} value={d.description} onChange={(md) => set({ description: md })} placeholder={t("i.description")} people={L.b.people} className="pj-create-desc" label={t("c.description")} />
        <div className="pj-create-pills">
          {status && (
            <CreatePill
              label={t("f.status")}
              icon={<StatusIcon category={status.category} color={status.color} fraction={L.fraction(status.id)} />}
              text={status.name}
              picker={(close) => <StatusPicker teamId={d.teamId} value={status.id} onClose={close} onPick={(id) => set({ statusId: id })} />}
            />
          )}
          <CreatePill label={t("f.priority")} icon={<PriorityIcon priority={d.priority} />} text={t(`prio.${d.priority}`)} picker={(close) => <PriorityPicker value={d.priority} onClose={close} onPick={(p) => set({ priority: p })} />} />
          <CreatePill
            label={t("f.assignee")}
            icon={assignee ? <Avatar name={assignee.name} id={assignee.id} size={16} src={assignee.avatar} /> : <UnassignedIcon size={16} />}
            text={assignee?.name ?? t("i.unassigned")}
            empty={!assignee}
            picker={(close) => <AssigneePicker value={d.assigneeId} onClose={close} onPick={(id) => set({ assigneeId: id })} />}
          />
          <CreatePill
            label={t("f.labels")}
            icon={labels.length ? <span className="pj-dots">{labels.slice(0, 3).map((l) => <span key={l!.id} className="pj-dot" style={{ background: uiColor(l!.color) }} />)}</span> : <Tag size={14} />}
            text={labels.length ? labels.map((l) => l!.name).join(", ") : t("f.labels")}
            empty={!labels.length}
            picker={(close) => (
              <LabelPicker
                teamId={d.teamId}
                value={d.labelIds}
                onClose={close}
                onToggle={(id, on) => {
                  const lb = L.label.get(id);
                  setD((x) => {
                    let next = on ? [...x.labelIds, id] : x.labelIds.filter((y) => y !== id);
                    if (on && lb?.parentId) next = next.filter((y) => y === id || L.label.get(y)?.parentId !== lb.parentId);
                    return { ...x, labelIds: next };
                  });
                }}
              />
            )}
          />
          <CreatePill
            label={t("f.project")}
            icon={project ? <ProjectGlyph icon={project.icon} color={project.color} size={14} /> : <Box size={14} />}
            text={project?.name ?? t("f.project")}
            empty={!project}
            picker={(close) => <ProjectPicker value={d.projectId} onClose={close} onPick={(id) => set({ projectId: id, milestoneId: null })} />}
          />
          {team?.cyclesEnabled && (
            <CreatePill
              label={t("f.cycle")}
              icon={cycle ? <CycleGlyph size={14} progress={0.5} /> : <RefreshCcw size={13} />}
              text={cycle ? cycle.name || t("cy.name", { n: cycle.number }) : t("f.cycle")}
              empty={!cycle}
              picker={(close) => <CyclePicker teamId={d.teamId} value={d.cycleId} onClose={close} onPick={(id) => set({ cycleId: id })} />}
            />
          )}
          {team && team.estimates !== "none" && (
            <CreatePill
              label={t("p.estimate")}
              icon={<Gauge size={14} />}
              text={d.estimate !== null ? estimateLabel(team.estimates, d.estimate) : t("p.estimate")}
              empty={d.estimate === null}
              picker={(close) => <EstimatePicker teamId={d.teamId} value={d.estimate} onClose={close} onPick={(v) => set({ estimate: v })} />}
            />
          )}
          <CreatePill label={t("f.due")} icon={<CalendarDays size={14} />} text={d.dueDate ? f.day(d.dueDate) : t("f.due")} empty={!d.dueDate} wide picker={(close) => <DatePicker value={d.dueDate} onClose={close} onPick={(v) => set({ dueDate: v })} />} />
        </div>
        <div className="pj-create-foot">
          <label className="pj-check-row">
            <Toggle on={more} onChange={setMore} label={t("i.createMore")} />
            <span className="pj-small">{t("i.createMore")}</span>
          </label>
          <button type="submit" className="pj-btn pj-btn-primary" disabled={!d.title.trim() || busy || !team} title={`${modKey()}+Enter`}>
            {t("i.create")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Issues that may already say the same, while the title is typed: the
 * full-text index finds them, smart suggestions (when on) say which one is the same.
 * They open in a new tab, so the draft stays.
 */
function SimilarIssues({ title, description }: { title: string; description: string }) {
  const { t } = useT();
  const [res, setRes] = useState<{ issues: { id: string; identifier: string; title: string; confidence?: number }[]; source: "model" | "rules" } | null>(null);
  useEffect(() => {
    const q = title.trim();
    if ([...q].length < 6) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      api<{ issues: { id: string; identifier: string; title: string; confidence?: number }[]; source: "model" | "rules" }>("assist", { method: "POST", body: { action: "similar", title: q, description: description.slice(0, 2000) }, signal: ctl.signal })
        .then(setRes)
        .catch(() => undefined);
    }, 600);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [title, description]);
  if (!res || !res.issues.length || [...title.trim()].length < 6) return null;
  const smart = res.source === "model" && res.issues[0]?.confidence !== undefined;
  return (
    <div className="pj-similar" data-source={res.source}>
      <span className="pj-similar-head">{smart ? t("c.similarSmart", { p: Math.round((res.issues[0].confidence ?? 0) * 100) }) : t("c.similar")}</span>
      {res.issues.map((i) => (
        <a key={i.id} href={href(`/issue/${i.identifier}`)} target="_blank" rel="noopener" className="pj-similar-item">
          <b>{i.identifier}</b> {i.title}
        </a>
      ))}
    </div>
  );
}

/** A property of the new issue as zvena's Pill: one click opens its picker. */
function CreatePill({ label, icon, text, picker, wide, empty }: { label: string; icon: ReactNode; text: string; picker: (close: () => void) => ReactNode; wide?: boolean; empty?: boolean }) {
  const pop = usePopover();
  return (
    <>
      <Pill icon={icon} title={label} tone={empty ? "empty" : "default"} onClick={(e) => pop.toggle(e.currentTarget)}>
        {text}
      </Pill>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={wide ? 268 : 250} label={label}>
          {picker(pop.close)}
        </Popover>
      )}
    </>
  );
}

