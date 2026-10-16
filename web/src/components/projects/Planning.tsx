"use client";

// Projects (list, page with overview / issues / updates, milestones and
// dependencies), the roadmap (a timeline of projects with draggable dates
// and dependency arrows) and cycles (list and page with burn-up and load).

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Archive, Box, CalendarRange, ChevronRight, Diamond, FileText, Map as MapIcon, MoreHorizontal, Plus, RefreshCcw, Sparkles, Star, Trash2, Users } from "lucide-react";
import { PROJECT_STATES, type Cycle, type CycleSummary, type Health, type Project, type ProjectDetail, type ProjectState } from "@/lib/projects/types";
import { openCreate } from "./app-state";
import { api, errorText, invalidateAll, loadBoot, toast, toggleFavorite, useLookups, useQuery, workspaceId } from "./data";
import { ProjectEcosystem } from "@/components/eco/IssueEcosystem";
import { BlockersPanel, CycleReportButton, DraftUpdateButton } from "./Assistant";
import { MarkdownEditor, MarkdownView } from "./Editor";
import { CycleGlyph, Glyph, HEALTH_COLOR, HealthDot, PriorityIcon, ProjectGlyph, ProjectStateIcon, uiColor } from "./icons";
import { useT, type PT } from "./i18n";
import { intlOf } from "@/i18n/locales";
import { IssuesScreen } from "./IssuesScreen";
import { AssigneePicker, PriorityPicker } from "./pickers";
import { Link, navigate, setParams, useLoc } from "./router";
import { Tabs } from "./Screens";
import { Avatar, confirmDialog, DatePicker, Empty, ErrorState, IconButton, LoadingRows, Menu, Modal, Popover, useFormat, usePopover, type MenuItem } from "./ui";

// --- Shared bits -----------------------------------------------------------------

function Progress({ done, total, width = 64 }: { done: number; total: number; width?: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <span className="pj-progress" title={`${done}/${total}`}>
      <span className="pj-progress-bar" style={{ width }}>
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className="pj-progress-pct">{pct}%</span>
    </span>
  );
}

function stateLabel(t: PT, s: ProjectState) {
  return t(`ps.${s}`);
}

function healthLabel(t: PT, h: Health | null) {
  return h ? t(`h.${h}`) : t("h.none");
}

async function patchProject(id: string, body: Record<string, unknown>, t: PT): Promise<boolean> {
  try {
    await api(`projects/${id}`, { method: "PATCH", body });
    await loadBoot();
    invalidateAll();
    return true;
  } catch (e) {
    toast(errorText(e, t), "error");
    return false;
  }
}

function Picker({ label, children, picker, width = 250, disabled }: { label: string; children: ReactNode; picker: (close: () => void) => ReactNode; width?: number; disabled?: boolean }) {
  const pop = usePopover();
  return (
    <>
      <button type="button" className="pj-pill" title={label} disabled={disabled} onClick={(e) => pop.toggle(e.currentTarget)}>
        <span className="pj-sr">{label}: </span>
        {children}
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={width} label={label}>
          {picker(pop.close)}
        </Popover>
      )}
    </>
  );
}

function StatePicker({ value, onPick, onClose }: { value: ProjectState; onPick: (s: ProjectState) => void; onClose: () => void }) {
  const { t } = useT();
  const items: MenuItem[] = PROJECT_STATES.map((s) => ({ id: s, label: stateLabel(t, s), icon: <ProjectStateIcon state={s} />, checked: s === value, onSelect: () => onPick(s) }));
  return <Menu items={items} onClose={onClose} search={false} />;
}

function TeamsPicker({ value, onChange, onClose }: { value: string[]; onChange: (ids: string[]) => void; onClose: () => void }) {
  const L = useLookups();
  const items: MenuItem[] = L.b.teams.map((x) => ({
    id: x.id,
    label: x.name,
    icon: <Glyph icon={x.icon} color={x.color} text={x.name} size={16} />,
    checked: value.includes(x.id),
    onSelect: () => onChange(value.includes(x.id) ? value.filter((y) => y !== x.id) : [...value, x.id]),
  }));
  return <Menu items={items} onClose={onClose} multi />;
}

function PeoplePicker({ value, onChange, onClose }: { value: string[]; onChange: (ids: string[]) => void; onClose: () => void }) {
  const L = useLookups();
  const items: MenuItem[] = L.b.people
    .filter((p) => p.role)
    .map((p) => ({ id: p.id, label: p.name, icon: <Avatar name={p.name} id={p.id} size={16} src={p.avatar} />, checked: value.includes(p.id), onSelect: () => onChange(value.includes(p.id) ? value.filter((y) => y !== p.id) : [...value, p.id]) }));
  return <Menu items={items} onClose={onClose} multi />;
}

function ProjectsDepPicker({ self, value, onChange, onClose }: { self: string; value: string[]; onChange: (ids: string[]) => void; onClose: () => void }) {
  const L = useLookups();
  const items: MenuItem[] = L.b.projects
    .filter((p) => p.id !== self)
    .map((p) => ({ id: p.id, label: p.name, icon: <ProjectGlyph icon={p.icon} color={p.color} />, checked: value.includes(p.id), onSelect: () => onChange(value.includes(p.id) ? value.filter((y) => y !== p.id) : [...value, p.id]) }));
  return <Menu items={items} onClose={onClose} multi />;
}

// --- Projects list ---------------------------------------------------------------

export function ProjectsList({ teamKey }: { teamKey?: string }) {
  const { t } = useT();
  const L = useLookups();
  const f = useFormat();
  const loc = useLoc();
  const team = teamKey ? L.teamByKey.get(teamKey) : null;
  const tab = loc.params.get("tab") ?? "active";
  const [creating, setCreating] = useState(false);
  const [fromDoc, setFromDoc] = useState(false);
  const all = L.b.projects.filter((p) => !team || p.teamIds.includes(team.id));
  const list = all.filter((p) => (tab === "all" ? true : tab === "completed" ? p.state === "completed" || p.state === "canceled" : p.state !== "completed" && p.state !== "canceled"));
  const tabs = [
    { key: "active", label: t("nav.active") },
    { key: "completed", label: t("ps.completed") },
    { key: "all", label: t("pr.all") },
  ];
  return (
    <div className="pj-screen">
      <header className="pj-head">
        <div className="pj-head-title">
          {team ? <Glyph icon={team.icon} color={team.color} text={team.name} size={18} /> : <Box size={16} />}
          <h1>{team ? `${team.name} · ${t("pr.title")}` : t("pr.title")}</h1>
          <span className="pj-head-count">{list.length}</span>
        </div>
        <nav className="pj-tabs">
          {tabs.map((x) => (
            <button key={x.key} type="button" className="pj-tab" aria-current={tab === x.key ? "page" : undefined} onClick={() => setParams({ tab: x.key === "active" ? null : x.key })}>
              {x.label}
            </button>
          ))}
        </nav>
        <div className="pj-head-actions">
          {L.canEdit && (
            <button type="button" className="pj-btn pj-btn-sm pj-btn-ghost" onClick={() => setFromDoc(true)} title={t("doc.hint")}>
              <FileText size={14} />
              <span className="pj-hide-sm">{t("doc.button")}</span>
            </button>
          )}
          {L.canEdit && (
            <button type="button" className="pj-btn pj-btn-sm" onClick={() => setCreating(true)}>
              <Plus size={14} />
              <span className="pj-hide-sm">{t("pr.new")}</span>
            </button>
          )}
        </div>
      </header>
      <div className="pj-screen-body">
        {list.length === 0 ? (
          <Empty
            icon={<Box size={22} />}
            title={t("pr.empty")}
            hint={t("pr.emptyHint")}
            starts={
              L.canEdit
                ? [
                    { id: "new", label: t("pr.new"), icon: <Box size={16} />, tint: "var(--ui-tint-orange)", onClick: () => setCreating(true) },
                    { id: "doc", label: t("doc.button"), icon: <FileText size={16} />, tint: "var(--ui-tint-purple)", onClick: () => setFromDoc(true) },
                  ]
                : []
            }
          />
        ) : (
          <div className="pj-ptable" role="table">
            <div className="pj-ptable-head" role="row">
              <span role="columnheader">{t("c.name")}</span>
              <span role="columnheader">{t("pr.health")}</span>
              <span role="columnheader">{t("pr.lead")}</span>
              <span role="columnheader">{t("pr.target")}</span>
              <span role="columnheader">{t("pr.progress")}</span>
              <span role="columnheader">{t("pr.state")}</span>
            </div>
            {list.map((p) => {
              const lead = p.leadId ? L.person.get(p.leadId) : null;
              const overdue = p.targetDate && p.targetDate < L.b.today && p.state !== "completed" && p.state !== "canceled";
              return (
                <div key={p.id} className="pj-ptable-row" role="row" onClick={() => navigate(`/project/${p.id}`)}>
                  <span className="pj-ptable-name" role="cell">
                    <ProjectGlyph icon={p.icon} color={p.color} />
                    <Link to={`/project/${p.id}`} onClick={(e) => e.stopPropagation()}>
                      {p.name}
                    </Link>
                    {p.priority > 0 && <PriorityIcon priority={p.priority} size={14} />}
                  </span>
                  <span className="pj-ptable-cell" role="cell">
                    <HealthDot health={p.health} />
                    <span className="pj-small">{healthLabel(t, p.health)}</span>
                  </span>
                  <span className="pj-ptable-cell" role="cell">{lead ? <Avatar name={lead.name} id={lead.id} size={20} src={lead.avatar} /> : <span className="pj-muted">—</span>}</span>
                  <span role="cell" className={`pj-ptable-cell pj-small ${overdue ? "pj-overdue" : ""}`}>{p.targetDate ? f.day(p.targetDate) : "—"}</span>
                  <span className="pj-ptable-cell" role="cell">
                    <Progress done={p.progress.completed} total={p.progress.total} />
                  </span>
                  <span className="pj-ptable-cell" role="cell">
                    <ProjectStateIcon state={p.state} />
                    <span className="pj-small">{stateLabel(t, p.state)}</span>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {creating && <NewProjectDialog teamId={team?.id} onClose={() => setCreating(false)} />}
      {fromDoc && <FromDocDialog teamId={team?.id} onClose={() => setFromDoc(false)} />}
    </div>
  );
}

// --- Goals and tasks from a document (Jev) -----------------------------------------

interface DocLine {
  text: string;
  block: "heading" | "item" | "check" | "text";
  checked?: boolean;
  kind: "goal" | "task" | "none";
  confidence?: number;
  goal?: number;
  exists?: string;
  blockId?: string;
}

/**
 * A Docs page → projects (its goals) and issues (the work under them). Jev
 * reads the lines (rules when it is off); the person ticks what to create.
 */
function FromDocDialog({ teamId, onClose }: { teamId?: string; onClose: () => void }) {
  const { t } = useT();
  const L = useLookups();
  const myTeams = L.b.teams.filter((x) => x.isMember && !x.archivedAt);
  const [q, setQ] = useState("");
  const [docs, setDocs] = useState<{ id: string; title: string; icon?: string; sub?: string }[] | null>(null);
  const [plan, setPlan] = useState<{ note: { id: string; title: string }; lines: DocLine[]; source: "jev" | "rules" } | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [team, setTeam] = useState(teamId ?? myTeams[0]?.id ?? L.b.teams[0]?.id ?? "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (plan) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/eco/search?ws=${encodeURIComponent(workspaceId())}&q=${encodeURIComponent(q.trim())}`, { credentials: "same-origin", signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : { hits: [] }))
        .then((r: { hits?: { key: string; kind: string; title: string; icon?: string; sub?: string }[] }) =>
          setDocs((r.hits ?? []).filter((h) => h.kind === "note").map((h) => ({ id: h.key.slice(5), title: h.title, icon: h.icon, sub: h.sub })))
        )
        .catch(() => undefined);
    }, 250);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [q, plan]);

  const open = async (id: string) => {
    setBusy(true);
    try {
      const p = await api<{ note: { id: string; title: string }; lines: DocLine[]; source: "jev" | "rules" }>("assist", { method: "POST", body: { action: "fromDoc", noteId: id } });
      setPlan(p);
      setPicked(new Set(p.lines.map((l, i) => (l.kind !== "none" && !l.exists ? i : -1)).filter((i) => i >= 0)));
    } catch (e) {
      toast(errorText(e, t), "error");
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!plan) return;
    const goals = plan.lines.map((l, i) => ({ l, i })).filter(({ l, i }) => l.kind === "goal" && picked.has(i));
    const goalIndex = new Map(goals.map(({ i }, n) => [i, n]));
    const tasks = plan.lines
      .map((l, i) => ({ l, i }))
      .filter(({ l, i }) => l.kind === "task" && picked.has(i))
      .map(({ l }) => ({ text: l.text, goal: l.goal !== undefined ? goalIndex.get(l.goal) : undefined, done: l.checked === true, ...(l.blockId ? { blockId: l.blockId } : {}) }));
    setBusy(true);
    try {
      const r = await api<{ projects: string[]; issues: string[]; converting: number }>("from-doc", { method: "POST", body: { teamId: team, noteId: plan.note.id, goals: goals.map(({ l }) => ({ text: l.text })), tasks } });
      // The document lists what it became (zvena's links: Related on both sides).
      for (const dst of [...r.projects.map((id) => `project:${id}`), ...r.issues.map((id) => `issue:${id}`)])
        void fetch(`/api/eco/link?ws=${encodeURIComponent(workspaceId())}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ src: `note:${plan.note.id}`, dst }) }).catch(() => undefined);
      await loadBoot();
      invalidateAll();
      const docUrl = `/docs?ws=${encodeURIComponent(workspaceId())}#${plan.note.id}`;
      toast(
        r.converting ? `${t("doc.done", { p: r.projects.length, i: r.issues.length })} ${t("doc.converting")}` : t("doc.done", { p: r.projects.length, i: r.issues.length }),
        "success",
        r.converting ? { label: t("doc.openDoc"), run: () => window.location.assign(docUrl) } : undefined,
        r.converting ? 10_000 : undefined
      );
      onClose();
      if (r.projects.length === 1) navigate(`/project/${r.projects[0]}`);
    } catch (e) {
      toast(errorText(e, t), "error");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (i: number) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  const useful = plan ? plan.lines.map((l, i) => ({ l, i })).filter(({ l }) => l.kind !== "none") : [];

  return (
    <Modal onClose={onClose} label={t("doc.title")} width={620}>
      <div className="pj-form pj-fromdoc">
        <h2>{t("doc.title")}</h2>
        {!plan ? (
          <>
            <p className="pj-small pj-muted">{t("doc.hint")}</p>
            <input className="pj-input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("doc.search")} aria-label={t("doc.search")} />
            <div className="pj-fromdoc-list" role="listbox" aria-label={t("doc.search")}>
              {docs === null ? (
                <LoadingRows rows={3} />
              ) : docs.length === 0 ? (
                <p className="pj-small pj-muted">{t("doc.none")}</p>
              ) : (
                docs.map((d) => (
                  <button key={d.id} type="button" role="option" aria-selected={false} className="pj-fromdoc-doc" disabled={busy} onClick={() => void open(d.id)}>
                    <span aria-hidden>{d.icon || <FileText size={14} />}</span>
                    <span className="pj-fromdoc-doc-title">{d.title || "—"}</span>
                    {d.sub && <span className="pj-small pj-muted">{d.sub}</span>}
                  </button>
                ))
              )}
            </div>
          </>
        ) : (
          <>
            <div className="pj-fromdoc-head">
              <FileText size={14} />
              <b>{plan.note.title || "—"}</b>
              <span className="pj-assist-source" data-source={plan.source}>
                {plan.source === "jev" ? (
                  <>
                    <Sparkles size={11} /> {t("doc.byJev")}
                  </>
                ) : (
                  t("doc.byRules")
                )}
              </span>
              <button type="button" className="pj-link pj-small" onClick={() => setPlan(null)}>
                {t("doc.back")}
              </button>
            </div>
            {useful.length === 0 ? (
              <p className="pj-small pj-muted">{t("doc.empty")}</p>
            ) : (
              <div className="pj-fromdoc-lines">
                {useful.map(({ l, i }) => (
                  <label key={i} className="pj-fromdoc-line" data-kind={l.kind} data-child={l.kind === "task" && l.goal !== undefined ? "" : undefined}>
                    <input type="checkbox" checked={picked.has(i)} onChange={() => toggle(i)} />
                    <span className="pj-tag">{l.kind === "goal" ? t("doc.goal") : t("doc.task")}</span>
                    <span className="pj-fromdoc-text">{l.text}</span>
                    {l.exists && <span className="pj-small pj-muted">{t("doc.exists", { id: l.exists })}</span>}
                    {l.confidence !== undefined && <span className="pj-jev-conf">{Math.round(l.confidence * 100)}%</span>}
                  </label>
                ))}
              </div>
            )}
            <div className="pj-row-end">
              <label className="pj-small">
                {t("doc.team")}{" "}
                <select className="pj-select pj-select-sm" value={team} onChange={(e) => setTeam(e.target.value)}>
                  {L.b.teams
                    .filter((x) => !x.archivedAt)
                    .map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                </select>
              </label>
              <button type="button" className="pj-btn pj-btn-primary" disabled={busy || !picked.size || !team} onClick={() => void create()}>
                {t("doc.create", { n: picked.size })}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function NewProjectDialog({ teamId, onClose }: { teamId?: string; onClose: () => void }) {
  const { t } = useT();
  const L = useLookups();
  const f = useFormat();
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [state, setState] = useState<ProjectState>("planned");
  const [priority, setPriority] = useState<0 | 1 | 2 | 3 | 4>(0);
  const [leadId, setLead] = useState<string | null>(L.b.me.id);
  const [teams, setTeams] = useState<string[]>(teamId ? [teamId] : L.b.teams.filter((x) => x.isMember).slice(0, 1).map((x) => x.id));
  const [start, setStart] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [icon, setIcon] = useState("");
  const [busy, setBusy] = useState(false);
  const lead = leadId ? L.person.get(leadId) : null;
  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const p = await api<ProjectDetail>("projects", { method: "POST", body: { name, summary, description, state, priority, leadId, teamIds: teams, startDate: start, targetDate: target, icon: icon.trim() || null } });
      await loadBoot();
      onClose();
      navigate(`/project/${p.id}`);
    } catch (e) {
      toast(errorText(e, t), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label={t("pr.new")} width={680} className="pj-create">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && void submit()}
      >
        <div className="pj-create-head">
          <Box size={15} />
          <span className="pj-small pj-muted">{t("pr.new")}</span>
        </div>
        <div className="pj-create-row">
          <input className="pj-emoji-input" value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="🚀" aria-label={t("c.icon")} maxLength={4} />
          <input className="pj-create-title" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("pr.name")} aria-label={t("pr.name")} maxLength={120} />
        </div>
        <input className="pj-create-summary" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder={t("pr.summary")} aria-label={t("pr.summary")} maxLength={255} />
        <div className="pj-create-pills">
          <Picker label={t("pr.state")} picker={(close) => <StatePicker value={state} onPick={setState} onClose={close} />}>
            <ProjectStateIcon state={state} />
            {stateLabel(t, state)}
          </Picker>
          <Picker label={t("f.priority")} picker={(close) => <PriorityPicker value={priority} onPick={setPriority} onClose={close} />}>
            <PriorityIcon priority={priority} />
            {t(`prio.${priority}`)}
          </Picker>
          <Picker label={t("pr.lead")} picker={(close) => <AssigneePicker value={leadId} onPick={setLead} onClose={close} />}>
            {lead ? <Avatar name={lead.name} id={lead.id} size={16} /> : <Users size={14} />}
            {lead?.name ?? t("pr.noLead")}
          </Picker>
          <Picker label={t("pr.teams")} picker={(close) => <TeamsPicker value={teams} onChange={setTeams} onClose={close} />}>
            <Users size={14} />
            {teams.map((id) => L.team.get(id)?.key).join(", ") || t("pr.teams")}
          </Picker>
          <Picker label={t("pr.start")} width={268} picker={(close) => <DatePicker value={start} onPick={setStart} onClose={close} />}>
            <CalendarRange size={14} />
            {start ? f.day(start) : t("pr.start")}
          </Picker>
          <Picker label={t("pr.target")} width={268} picker={(close) => <DatePicker value={target} onPick={setTarget} onClose={close} />}>
            <CalendarRange size={14} />
            {target ? f.day(target) : t("pr.target")}
          </Picker>
        </div>
        <MarkdownEditor value="" onChange={setDescription} placeholder={t("pr.description")} people={L.b.people} className="pj-create-desc" />
        <div className="pj-create-foot">
          <span />
          <button type="submit" className="pj-btn pj-btn-primary" disabled={!name.trim() || busy}>
            {t("c.create")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// --- Project page ----------------------------------------------------------------

export function ProjectPage({ id, tab }: { id: string; tab?: string }) {
  const { t } = useT();
  const { data, error, loading, reload } = useQuery<ProjectDetail>(`project:${id}`, () => api<ProjectDetail>(`projects/${id}`));
  if (error) return error.status === 404 ? <Empty title={t("pr.notFound")} /> : <ErrorState onRetry={reload} />;
  if (loading || !data) return <LoadingRows />;
  return <ProjectLoaded p={data} tab={tab === "issues" || tab === "updates" ? tab : "overview"} />;
}

function ProjectLoaded({ p, tab }: { p: ProjectDetail; tab: "overview" | "issues" | "updates" }) {
  const { t } = useT();
  const L = useLookups();
  const more = usePopover();
  const fav = L.isFavorite("project", p.id);
  const menu: MenuItem[] = [
    { id: "fav", label: fav ? t("c.unfavorite") : t("c.favorite"), icon: <Star size={14} />, onSelect: () => void toggleFavorite("project", p.id, !fav) },
  ];
  if (L.canEdit)
    menu.push({
      id: "archive",
      label: p.archivedAt ? t("i.unarchive") : t("i.archive"),
      icon: <Archive size={14} />,
      onSelect: () => void patchProject(p.id, { archived: !p.archivedAt }, t).then((ok) => ok && !p.archivedAt && toast(t("pr.archived"), "success")),
    });
  if (L.isOwner)
    menu.push({
      id: "delete",
      label: t("c.delete"),
      icon: <Trash2 size={14} />,
      danger: true,
      onSelect: async () => {
        if (!(await confirmDialog({ title: t("pr.deleteConfirm", { name: p.name }), ok: t("c.delete"), danger: true }))) return;
        try {
          await api(`projects/${p.id}`, { method: "DELETE" });
          await loadBoot();
          navigate("/projects");
        } catch (e) {
          toast(errorText(e, t), "error");
        }
      },
    });
  return (
    <div className="pj-screen">
      <header className="pj-head">
        <div className="pj-head-title">
          <Link to="/projects" className="pj-crumb">
            {t("pr.title")}
          </Link>
          <ChevronRight size={13} className="pj-muted-icon" />
          <ProjectGlyph icon={p.icon} color={p.color} />
          <h1>{p.name}</h1>
        </div>
        <Tabs
          items={[
            { to: `/project/${p.id}`, label: t("pr.overview"), active: tab === "overview" },
            { to: `/project/${p.id}/issues`, label: `${t("pr.issues")} · ${p.progress.total}`, active: tab === "issues" },
            { to: `/project/${p.id}/updates`, label: t("pr.updates"), active: tab === "updates" },
          ]}
        />
        <div className="pj-head-actions">
          <IconButton label={fav ? t("c.unfavorite") : t("c.favorite")} active={fav} onClick={() => void toggleFavorite("project", p.id, !fav)}>
            <Star size={15} fill={fav ? "currentColor" : "none"} />
          </IconButton>
          <IconButton label={t("i.moreActions")} onClick={(e) => more.toggle(e.currentTarget)}>
            <MoreHorizontal size={16} />
          </IconButton>
        </div>
      </header>
      {more.anchor && (
        <Popover anchor={more.anchor} onClose={more.close} width={220} align="end" label={t("i.moreActions")}>
          <Menu items={menu} onClose={more.close} search={false} />
        </Popover>
      )}
      {tab === "issues" ? (
        <IssuesScreen key={p.id} embedded title={p.name} scope={{ projectId: p.id }} hide={["project"]} memoryKey={`project-${p.id}`} create={{ projectId: p.id, teamId: p.teamIds[0] }} />
      ) : tab === "updates" ? (
        <ProjectUpdates p={p} />
      ) : (
        <ProjectOverview p={p} />
      )}
    </div>
  );
}

function ProjectOverview({ p }: { p: ProjectDetail }) {
  const { t } = useT();
  const L = useLookups();
  const f = useFormat();
  const can = L.canEdit;
  const [summary, setSummary] = useState(p.summary);
  const [name, setName] = useState(p.name);
  const [icon, setIcon] = useState(p.icon ?? "");
  const [was, setWas] = useState({ summary: p.summary, name: p.name, icon: p.icon });
  if (was.summary !== p.summary || was.name !== p.name || was.icon !== p.icon) {
    setWas({ summary: p.summary, name: p.name, icon: p.icon });
    setSummary(p.summary);
    setName(p.name);
    setIcon(p.icon ?? "");
  }
  const lead = p.leadId ? L.person.get(p.leadId) : null;
  const blocksProjects = L.b.projects.filter((x) => x.dependsOn.includes(p.id));
  const last = p.updates[0];
  return (
    <div className="pj-screen-body pj-project">
      <div className="pj-project-main">
        <div className="pj-project-title">
          <input
            className="pj-emoji-input"
            value={icon}
            readOnly={!can}
            placeholder="📦"
            maxLength={4}
            aria-label={t("c.icon")}
            onChange={(e) => setIcon(e.target.value)}
            onBlur={() => icon !== (p.icon ?? "") && void patchProject(p.id, { icon: icon.trim() || null }, t)}
          />
          <input
            value={name}
            readOnly={!can}
            aria-label={t("pr.name")}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => (name.trim() ? name !== p.name && void patchProject(p.id, { name: name.trim() }, t) : setName(p.name))}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        </div>
        <input
          className="pj-project-summary"
          value={summary}
          readOnly={!can}
          placeholder={t("pr.summary")}
          aria-label={t("pr.summary")}
          onChange={(e) => setSummary(e.target.value)}
          onBlur={() => summary !== p.summary && void patchProject(p.id, { summary }, t)}
          maxLength={255}
        />
        <div className="pj-create-pills pj-project-pills">
          <Picker label={t("pr.state")} disabled={!can} picker={(close) => <StatePicker value={p.state} onPick={(s) => void patchProject(p.id, { state: s }, t)} onClose={close} />}>
            <ProjectStateIcon state={p.state} />
            {stateLabel(t, p.state)}
          </Picker>
          <Picker label={t("f.priority")} disabled={!can} picker={(close) => <PriorityPicker value={p.priority} onPick={(v) => void patchProject(p.id, { priority: v }, t)} onClose={close} />}>
            <PriorityIcon priority={p.priority} />
            {t(`prio.${p.priority}`)}
          </Picker>
          <Picker label={t("pr.lead")} disabled={!can} picker={(close) => <AssigneePicker value={p.leadId} onPick={(v) => void patchProject(p.id, { leadId: v }, t)} onClose={close} />}>
            {lead ? <Avatar name={lead.name} id={lead.id} size={16} /> : <Users size={14} />}
            {lead?.name ?? t("pr.noLead")}
          </Picker>
          <Picker label={t("pr.members")} disabled={!can} picker={(close) => <PeoplePicker value={p.memberIds} onChange={(ids) => void patchProject(p.id, { memberIds: ids }, t)} onClose={close} />}>
            <span className="pj-avatars">
              {p.memberIds.slice(0, 4).map((m) => (
                <Avatar key={m} name={L.person.get(m)?.name ?? "?"} id={m} size={16} />
              ))}
            </span>
            {p.memberIds.length ? p.memberIds.length : t("pr.members")}
          </Picker>
          <Picker label={t("pr.teams")} disabled={!can} picker={(close) => <TeamsPicker value={p.teamIds} onChange={(ids) => void patchProject(p.id, { teamIds: ids }, t)} onClose={close} />}>
            <Users size={14} />
            {p.teamIds.map((id) => L.team.get(id)?.key).join(", ") || t("pr.teams")}
          </Picker>
          <Picker label={t("pr.start")} width={268} disabled={!can} picker={(close) => <DatePicker value={p.startDate} onPick={(v) => void patchProject(p.id, { startDate: v }, t)} onClose={close} />}>
            <CalendarRange size={14} />
            {p.startDate ? f.day(p.startDate) : t("pr.start")}
          </Picker>
          <Picker label={t("pr.target")} width={268} disabled={!can} picker={(close) => <DatePicker value={p.targetDate} onPick={(v) => void patchProject(p.id, { targetDate: v }, t)} onClose={close} />}>
            <CalendarRange size={14} />
            {p.targetDate ? f.day(p.targetDate) : t("pr.target")}
          </Picker>
        </div>
        <MarkdownEditor key={p.id} value={p.description} editable={can} toolbar placeholder={can ? t("pr.description") : ""} people={L.b.people} onChange={(md) => void patchProject(p.id, { description: md }, t)} className="pj-description" />
        <Milestones p={p} />
        {/* zvena's ecosystem: the project's documents and designs (components/eco). */}
        <ProjectEcosystem ws={workspaceId()} projectId={p.id} canEdit={can} />
        <section className="pj-section">
          <div className="pj-section-head">
            <h2>{t("pr.dependsOn")}</h2>
            {can && (
              <Picker label={t("pr.dependsOn")} picker={(close) => <ProjectsDepPicker self={p.id} value={p.dependsOn} onChange={(ids) => void patchProject(p.id, { dependsOn: ids }, t)} onClose={close} />}>
                <Plus size={14} />
              </Picker>
            )}
          </div>
          {p.dependsOn.length === 0 && blocksProjects.length === 0 && <p className="pj-small pj-muted">—</p>}
          {p.dependsOn.map((d) => {
            const x = L.project.get(d);
            return x ? (
              <div key={d} className="pj-mini-row">
                <ProjectGlyph icon={x.icon} color={x.color} />
                <Link to={`/project/${x.id}`} className="pj-mini-title">
                  {x.name}
                </Link>
                <span className="pj-small pj-muted">{x.targetDate ? f.day(x.targetDate) : ""}</span>
              </div>
            ) : null;
          })}
          {blocksProjects.length > 0 && <div className="pj-rel-type">{t("pr.blocks")}</div>}
          {blocksProjects.map((x) => (
            <div key={x.id} className="pj-mini-row">
              <ProjectGlyph icon={x.icon} color={x.color} />
              <Link to={`/project/${x.id}`} className="pj-mini-title">
                {x.name}
              </Link>
            </div>
          ))}
        </section>
      </div>
      <aside className="pj-project-side">
        <div className="pj-card-box">
          <div className="pj-prop-label">{t("pr.progress")}</div>
          <Progress done={p.progress.completed} total={p.progress.total} width={140} />
          <div className="pj-small pj-muted">
            {p.progress.completed}/{p.progress.total} {t("pr.scope")}
            {p.progress.points ? ` · ${p.progress.pointsDone}/${p.progress.points} pts` : ""}
          </div>
        </div>
        <div className="pj-card-box">
          <div className="pj-prop-label">{t("pr.health")}</div>
          <div className="pj-health-row">
            <HealthDot health={p.health} size={10} />
            {healthLabel(t, p.health)}
          </div>
          {last && (
            <>
              <div className="pj-small pj-muted">
                {L.person.get(last.authorId ?? "")?.name} · {f.ago(last.createdAt)}
              </div>
              {last.auto ? <p className="pj-update-excerpt pj-update-auto">{t(`pu.auto.${last.auto}`)}</p> : <MarkdownView value={last.body} className="pj-update-excerpt" />}
            </>
          )}
          <Link to={`/project/${p.id}/updates`} className="pj-link pj-small">
            {t("pr.updates")} →
          </Link>
        </div>
        <BlockersPanel projectId={p.id} />
        {L.canEdit && (
          <button type="button" className="pj-btn pj-btn-sm" onClick={() => openCreate({ projectId: p.id, teamId: p.teamIds[0] })}>
            <Plus size={14} />
            {t("nav.newIssue")}
          </button>
        )}
      </aside>
    </div>
  );
}

function Milestones({ p }: { p: ProjectDetail }) {
  const { t } = useT();
  const L = useLookups();
  const f = useFormat();
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [adding, setAdding] = useState(false);
  const save = async () => {
    if (!name.trim()) return;
    try {
      await api(`projects/${p.id}/milestones`, { method: "POST", body: { name, targetDate: date || null } });
      setName("");
      setDate("");
      setAdding(false);
      await loadBoot();
      invalidateAll();
    } catch (e) {
      toast(errorText(e, t), "error");
    }
  };
  return (
    <section className="pj-section">
      <div className="pj-section-head">
        <h2>{t("pr.milestones")}</h2>
        {L.canEdit && (
          <button type="button" className="pj-btn pj-btn-sm pj-btn-ghost" onClick={() => setAdding(true)}>
            <Plus size={14} />
            {t("pr.addMilestone")}
          </button>
        )}
      </div>
      {p.milestones.map((m) => (
        <div key={m.id} className="pj-mini-row">
          <Diamond size={13} style={{ color: p.color }} />
          <span className="pj-mini-title">{m.name}</span>
          <span className={`pj-small ${m.targetDate && m.targetDate < L.b.today ? "pj-overdue" : "pj-muted"}`}>{m.targetDate ? f.day(m.targetDate) : ""}</span>
          {L.canEdit && (
            <button
              type="button"
              className="pj-icon-btn pj-icon-xs"
              aria-label={t("c.delete")}
              onClick={() =>
                void api(`projects/${p.id}/milestones/${m.id}`, { method: "DELETE" })
                  .then(() => loadBoot())
                  .then(() => invalidateAll())
                  .catch((e) => toast(errorText(e, t), "error"))
              }
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      ))}
      {adding && (
        <form
          className="pj-inline-add"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input className="pj-input pj-input-sm" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("c.name")} aria-label={t("c.name")} />
          <input className="pj-input pj-input-sm" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label={t("pr.target")} />
          <button type="submit" className="pj-btn pj-btn-sm pj-btn-primary" disabled={!name.trim()}>
            {t("c.add")}
          </button>
        </form>
      )}
    </section>
  );
}

function ProjectUpdates({ p }: { p: ProjectDetail }) {
  const { t } = useT();
  const L = useLookups();
  const f = useFormat();
  const [health, setHealth] = useState<Health>(p.health ?? "on_track");
  const [body, setBody] = useState("");
  const [key, setKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const post = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await api(`projects/${p.id}/updates`, { method: "POST", body: { health, body } });
      setBody("");
      setKey((k) => k + 1);
      await loadBoot();
      invalidateAll();
    } catch (e) {
      toast(errorText(e, t), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pj-screen-body pj-pad pj-updates">
      {L.canEdit && (
        <div className="pj-update-composer">
          <div className="pj-update-composer-head">
            <b>{t("pr.newUpdate")}</b>
            <div className="pj-seg pj-seg-sm" role="radiogroup" aria-label={t("pr.health")}>
              {(["on_track", "at_risk", "off_track"] as const).map((h) => (
                <button key={h} type="button" role="radio" aria-checked={health === h} data-on={health === h || undefined} onClick={() => setHealth(h)}>
                  <span className="pj-dot" style={{ background: HEALTH_COLOR[h] }} />
                  {t(`h.${h}`)}
                </button>
              ))}
            </div>
            <DraftUpdateButton
              projectId={p.id}
              onDraft={(d) => {
                setHealth(d.health);
                setBody(d.body);
                setKey((k) => k + 1);
              }}
            />
          </div>
          <MarkdownEditor key={key} value={body} onChange={setBody} placeholder={t("pr.writeUpdate")} people={L.b.people} toolbar onSubmit={(md) => {
            setBody(md);
            void post();
          }} />
          <div className="pj-row-end">
            <button type="button" className="pj-btn pj-btn-primary pj-btn-sm" disabled={busy || !body.trim()} onClick={() => void post()}>
              {t("pr.post")}
            </button>
          </div>
        </div>
      )}
      {p.updates.length === 0 ? (
        <Empty title={t("pr.noUpdates")} />
      ) : (
        p.updates.map((u) => {
          const a = u.authorId ? L.person.get(u.authorId) : null;
          return (
            <article key={u.id} className="pj-update">
              <header>
                <Avatar name={a?.name ?? "?"} id={u.authorId} size={22} />
                <b>{a?.name ?? t("act.former")}</b>
                <span className="pj-health-chip" style={{ ["--pj-h" as string]: HEALTH_COLOR[u.health] }}>
                  <span className="pj-dot" style={{ background: HEALTH_COLOR[u.health] }} />
                  {t(`h.${u.health}`)}
                </span>
                <time className="pj-tl-time">{f.dateTime(u.createdAt)}</time>
                {(u.authorId === L.b.me.id || L.isOwner) && (
                  <button
                    type="button"
                    className="pj-icon-btn pj-icon-xs"
                    aria-label={t("c.delete")}
                    onClick={() =>
                      void api(`updates/${u.id}`, { method: "DELETE" })
                        .then(() => invalidateAll())
                        .catch((e) => toast(errorText(e, t), "error"))
                    }
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </header>
              {u.auto ? <p className="pj-update-auto">{t(`pu.auto.${u.auto}`)}</p> : <MarkdownView value={u.body} />}
            </article>
          );
        })
      )}
    </div>
  );
}

// --- Roadmap ---------------------------------------------------------------------

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const DAY = 86_400_000;
const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function Roadmap() {
  const { t, lang } = useT();
  const L = useLookups();
  const loc = useLoc();
  const zoom = (loc.params.get("zoom") as "week" | "month" | "quarter") || "month";
  const pxDay = zoom === "week" ? 28 : zoom === "month" ? 8 : 3;
  const projects = L.b.projects.filter((p) => p.state !== "canceled");
  const dated = projects.filter((p) => p.startDate || p.targetDate);
  const undated = projects.filter((p) => !p.startDate && !p.targetDate);
  const today = toMs(L.b.today);
  const span = (p: Project) => {
    const s = p.startDate ? toMs(p.startDate) : Math.min(toMs(p.targetDate as string), toMs(toDay(p.createdAt)));
    const e = p.targetDate ? toMs(p.targetDate) : Math.max(s + 14 * DAY, today);
    return { s, e: Math.max(e, s) };
  };
  const min = Math.min(today - 30 * DAY, ...dated.map((p) => span(p).s)) - 14 * DAY;
  const max = Math.max(today + 120 * DAY, ...dated.map((p) => span(p).e)) + 30 * DAY;
  const start = new Date(min);
  start.setUTCDate(1);
  const origin = start.getTime();
  const width = Math.ceil((max - origin) / DAY) * pxDay;
  const x = (ms: number) => ((ms - origin) / DAY) * pxDay;
  const rowH = 40;
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = Math.max(0, x(today) - 240);
    // Scroll to today when the zoom changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);
  const [drag, setDrag] = useState<{ id: string; mode: "move" | "start" | "end"; x0: number; s: number; e: number; dx: number } | null>(null);
  const months: { ms: number; label: string }[] = [];
  const fmt = new Intl.DateTimeFormat(intlOf(lang), { month: zoom === "quarter" ? "short" : "long", year: "numeric", timeZone: "UTC" });
  for (let d = new Date(origin); d.getTime() < max; d.setUTCMonth(d.getUTCMonth() + 1)) months.push({ ms: d.getTime(), label: capitalize(fmt.format(d)) });
  const order = useMemo(() => [...dated].sort((a, b) => span(a).s - span(b).s), [dated]); // eslint-disable-line react-hooks/exhaustive-deps
  const index = new Map(order.map((p, i) => [p.id, i]));

  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    setDrag({ ...drag, dx: e.clientX - drag.x0 });
  };
  const onUp = () => {
    if (!drag) return;
    const days = Math.round(drag.dx / pxDay);
    const d = drag;
    setDrag(null);
    if (!days) return;
    let s = d.s;
    let e = d.e;
    if (d.mode === "move") {
      s += days * DAY;
      e += days * DAY;
    } else if (d.mode === "start") s = Math.min(e, s + days * DAY);
    else e = Math.max(s, e + days * DAY);
    void patchProject(d.id, { startDate: toDay(s), targetDate: toDay(e) }, t);
  };

  return (
    <div className="pj-screen">
      <header className="pj-head">
        <div className="pj-head-title">
          <MapIcon size={16} />
          <h1>{t("rm.title")}</h1>
        </div>
        <div className="pj-head-actions">
          <div className="pj-seg pj-seg-sm" role="radiogroup">
            {(["week", "month", "quarter"] as const).map((z) => (
              <button key={z} type="button" role="radio" aria-checked={zoom === z} data-on={zoom === z || undefined} onClick={() => setParams({ zoom: z === "month" ? null : z })}>
                {t(`rm.zoom.${z}`)}
              </button>
            ))}
          </div>
          <button type="button" className="pj-btn pj-btn-sm" onClick={() => scroller.current && (scroller.current.scrollLeft = Math.max(0, x(today) - 240))}>
            {t("rm.today")}
          </button>
        </div>
      </header>
      <div className="pj-screen-body pj-roadmap">
        {dated.length === 0 ? (
          <Empty icon={<MapIcon size={22} />} title={t("rm.title")} hint={t("rm.empty")} starts={[{ id: "projects", label: t("pr.title"), icon: <Box size={16} />, tint: "var(--ui-tint-orange)", onClick: () => navigate("/projects") }]} />
        ) : (
          <div className="pj-rm">
            <div className="pj-rm-names">
              <div className="pj-rm-corner" />
              {order.map((p) => (
                <div key={p.id} className="pj-rm-name" style={{ height: rowH }}>
                  <ProjectGlyph icon={p.icon} color={p.color} />
                  <Link to={`/project/${p.id}`}>{p.name}</Link>
                  <HealthDot health={p.health} />
                </div>
              ))}
            </div>
            <div className="pj-rm-scroll" ref={scroller} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
              <div className="pj-rm-canvas" style={{ width, height: order.length * rowH + 34 }}>
                <div className="pj-rm-months">
                  {months.map((m, i) => (
                    <div key={m.ms} className="pj-rm-month" style={{ left: x(m.ms), ["--pj-month-w" as string]: `${Math.max(0, x(months[i + 1]?.ms ?? max) - x(m.ms) - 8)}px` }}>
                      {m.label}
                    </div>
                  ))}
                </div>
                {months.map((m) => (
                  <div key={`g${m.ms}`} className="pj-rm-grid" style={{ left: x(m.ms) }} />
                ))}
                <div className="pj-rm-today" style={{ left: x(today) }} title={t("rm.today")} />
                <svg className="pj-rm-deps" width={width} height={order.length * rowH + 34} aria-hidden="true">
                  {order.flatMap((p) =>
                    p.dependsOn
                      .filter((d) => index.has(d))
                      .map((d) => {
                        const from = order[index.get(d) as number];
                        const fs = span(from);
                        const ps = span(p);
                        const x1 = x(fs.e + DAY);
                        const y1 = 34 + (index.get(d) as number) * rowH + rowH / 2;
                        const x2 = x(ps.s);
                        const y2 = 34 + (index.get(p.id) as number) * rowH + rowH / 2;
                        const late = fs.e >= ps.s;
                        return <path key={`${d}-${p.id}`} d={`M${x1},${y1} C${x1 + 30},${y1} ${x2 - 30},${y2} ${x2},${y2}`} className="pj-rm-dep" data-late={late || undefined} markerEnd="url(#pj-arrow)" />;
                      })
                  )}
                  <defs>
                    <marker id="pj-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                      <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
                    </marker>
                  </defs>
                </svg>
                {order.map((p, i) => {
                  const sp = span(p);
                  let s = sp.s;
                  let e = sp.e;
                  if (drag?.id === p.id) {
                    const days = Math.round(drag.dx / pxDay) * DAY;
                    if (drag.mode === "move") {
                      s += days;
                      e += days;
                    } else if (drag.mode === "start") s = Math.min(e, s + days);
                    else e = Math.max(s, e + days);
                  }
                  const pct = p.progress.total ? p.progress.completed / p.progress.total : 0;
                  const startDrag = (mode: "move" | "start" | "end") => (ev: React.PointerEvent) => {
                    if (!L.canEdit) return;
                    ev.preventDefault();
                    ev.stopPropagation();
                    (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
                    setDrag({ id: p.id, mode, x0: ev.clientX, s: sp.s, e: sp.e, dx: 0 });
                  };
                  return (
                    <div key={p.id} className="pj-rm-row" style={{ top: 34 + i * rowH, height: rowH }}>
                      <div
                        className="pj-rm-bar"
                        style={{ left: x(s), width: Math.max(pxDay, x(e + DAY) - x(s)), ["--pj-c" as string]: uiColor(p.color) }}
                        data-drag={drag?.id === p.id || undefined}
                        title={`${p.name}: ${toDay(s)} — ${toDay(e)}`}
                        onPointerDown={startDrag("move")}
                        onDoubleClick={() => navigate(`/project/${p.id}`)}
                      >
                        <span className="pj-rm-fill" style={{ width: `${pct * 100}%` }} />
                        <span className="pj-rm-label">{p.name}</span>
                        {L.canEdit && <span className="pj-rm-handle pj-rm-handle-l" onPointerDown={startDrag("start")} />}
                        {L.canEdit && <span className="pj-rm-handle pj-rm-handle-r" onPointerDown={startDrag("end")} />}
                      </div>
                      {p.milestones
                        .filter((m) => m.targetDate)
                        .map((m) => (
                          <span key={m.id} className="pj-rm-milestone" style={{ left: x(toMs(m.targetDate as string)) }} title={`${m.name} · ${m.targetDate}`}>
                            <Diamond size={11} />
                          </span>
                        ))}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
        {undated.length > 0 && (
          <div className="pj-rm-undated">
            <div className="pj-rm-undated-h">{t("rm.noDates")}</div>
            {undated.map((p) => (
              <Link key={p.id} to={`/project/${p.id}`} className="pj-tag">
                <ProjectGlyph icon={p.icon} color={p.color} size={13} /> {p.name}
              </Link>
            ))}
          </div>
        )}
        {L.canEdit && dated.length > 0 && <p className="pj-small pj-muted pj-pad">{t("rm.hint")}</p>}
      </div>
    </div>
  );
}

// --- Cycles ----------------------------------------------------------------------

export function CyclesList({ teamKey }: { teamKey: string }) {
  const { t } = useT();
  const L = useLookups();
  const f = useFormat();
  const team = L.teamByKey.get(teamKey);
  if (!team) return <Empty title={t("i.notFound")} />;
  const cycles = L.b.cycles.filter((c) => c.teamId === team.id);
  const cur = L.currentCycle(team.id);
  const upcoming = cycles.filter((c) => !c.completedAt && c.startsOn > L.b.today);
  const past = cycles.filter((c) => c.completedAt || c.endsOn < L.b.today).filter((c) => c.id !== cur?.id).reverse();
  const create = async () => {
    try {
      await api(`teams/${team.id}/cycles`, { method: "POST", body: {} });
      await loadBoot();
    } catch (e) {
      toast(errorText(e, t), "error");
    }
  };
  const row = (c: Cycle) => (
    <Link key={c.id} to={`/team/${team.key}/cycles/${c.number}`} className="pj-cycle-row">
      <CycleGlyph size={18} progress={c.progress.total ? c.progress.completed / c.progress.total : 0} />
      <span className="pj-cycle-name">{c.name || t("cy.name", { n: c.number })}</span>
      <span className="pj-small pj-muted">
        {f.day(c.startsOn)} — {f.day(c.endsOn)}
      </span>
      <span className="pj-cycle-row-end">
        {c.completedAt && <span className="pj-tag">{t("cy.completed")}</span>}
        <Progress done={c.progress.completed} total={c.progress.total} />
        <span className="pj-small pj-muted">
          {c.progress.completed}/{c.progress.total}
        </span>
      </span>
    </Link>
  );
  return (
    <div className="pj-screen">
      <header className="pj-head">
        <div className="pj-head-title">
          <Glyph icon={team.icon} color={team.color} text={team.name} size={18} />
          <h1>
            {team.name} · {t("cy.title")}
          </h1>
        </div>
        <div className="pj-head-actions">
          {L.canEdit && team.cyclesEnabled && (
            <button type="button" className="pj-btn pj-btn-sm" onClick={() => void create()}>
              <Plus size={14} />
              {t("cy.new")}
            </button>
          )}
        </div>
      </header>
      <div className="pj-screen-body pj-pad">
        {!team.cyclesEnabled && <div className="pj-banner">{t("cy.disabled")}</div>}
        {cycles.length === 0 ? (
          <Empty icon={<RefreshCcw size={22} />} title={t("cy.empty")} hint={t("cy.emptyHint")} starts={L.canEdit ? [{ id: "new", label: t("cy.new"), icon: <RefreshCcw size={16} />, tint: "var(--ui-tint-orange)", onClick: () => void create() }] : []} />
        ) : (
          <>
            {cur && (
              <section className="pj-cycle-sec">
                <h2>{t("cy.current")}</h2>
                {row(cur)}
              </section>
            )}
            {upcoming.length > 0 && (
              <section className="pj-cycle-sec">
                <h2>{t("cy.upcoming")}</h2>
                {upcoming.map(row)}
              </section>
            )}
            {past.length > 0 && (
              <section className="pj-cycle-sec">
                <h2>{t("cy.past")}</h2>
                {past.map(row)}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface CycleFull extends Cycle {
  summary: CycleSummary | null;
  burnup: { day: string; scope: number; completed: number }[];
  load: { userId: string | null; total: number; started: number; completed: number; points: number }[];
}

export function CyclePage({ teamKey, number }: { teamKey: string; number: string }) {
  const { t } = useT();
  const L = useLookups();
  const f = useFormat();
  const team = L.teamByKey.get(teamKey);
  const cycle = team ? L.b.cycles.find((c) => c.teamId === team.id && String(c.number) === number) : null;
  const { data, error, reload } = useQuery<CycleFull>(cycle ? `cycle:${cycle.id}` : null, () => api<CycleFull>(`cycles/${cycle?.id}`));
  const [completing, setCompleting] = useState(false);
  if (!team || !cycle) return <Empty title={t("cy.notFound")} />;
  const c = data ?? { ...cycle, summary: null, burnup: [], load: [] };
  const days = Math.max(1, Math.round((toMs(c.endsOn) - toMs(c.startsOn)) / DAY) + 1);
  const passed = Math.min(days, Math.max(0, Math.round((toMs(L.b.today) - toMs(c.startsOn)) / DAY) + 1));
  const fav = L.isFavorite("cycle", cycle.id);
  return (
    <div className="pj-screen">
      <header className="pj-head">
        <div className="pj-head-title">
          <Link to={`/team/${team.key}/cycles`} className="pj-crumb">
            {team.name} · {t("cy.title")}
          </Link>
          <ChevronRight size={13} className="pj-muted-icon" />
          <CycleGlyph size={16} progress={c.progress.total ? c.progress.completed / c.progress.total : 0} />
          <h1>{c.name || t("cy.name", { n: c.number })}</h1>
          <span className="pj-small pj-muted">
            {f.day(c.startsOn)} — {f.day(c.endsOn)}
          </span>
        </div>
        <div className="pj-head-actions">
          <IconButton label={fav ? t("c.unfavorite") : t("c.favorite")} active={fav} onClick={() => void toggleFavorite("cycle", cycle.id, !fav)}>
            <Star size={15} fill={fav ? "currentColor" : "none"} />
          </IconButton>
          {L.canEdit && !c.completedAt && (
            <button type="button" className="pj-btn pj-btn-sm" onClick={() => setCompleting(true)}>
              {t("cy.complete")}
            </button>
          )}
        </div>
      </header>
      {error ? (
        <ErrorState onRetry={reload} />
      ) : (
        <div className="pj-cycle-top">
          <div className="pj-stats">
            <Stat label={t("cy.scope")} value={c.progress.total} />
            <Stat label={t("cy.started")} value={c.progress.started} />
            <Stat label={t("cy.done")} value={c.progress.completed} sub={c.progress.total ? `${Math.round((c.progress.completed / c.progress.total) * 100)}%` : undefined} />
            {c.summary && <Stat label={t("cy.carried")} value={c.summary.carriedOver} />}
            <Stat label="" value={c.completedAt ? t("cy.completed") : t("cy.days", { passed, days })} />
          </div>
          {data && data.burnup.length > 1 && <Burnup data={data.burnup} t={t} />}
          {data && data.load.length > 0 && (
            <div className="pj-load">
              <div className="pj-prop-label">{t("cy.byAssignee")}</div>
              {data.load.map((l) => {
                const p = l.userId ? L.person.get(l.userId) : null;
                return (
                  <div key={l.userId ?? "none"} className="pj-load-row">
                    {l.userId ? <Avatar name={p?.name ?? "?"} id={l.userId} size={18} /> : <span className="pj-muted">—</span>}
                    <span className="pj-load-name">{l.userId ? (p?.name ?? t("act.former")) : t("f.noAssignee")}</span>
                    <Progress done={l.completed} total={l.total} width={80} />
                    <span className="pj-small pj-muted">
                      {l.completed}/{l.total}
                      {l.points ? ` · ${l.points} pts` : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <div className="pj-assist-row">
            <CycleReportButton cycleId={cycle.id} />
            <BlockersPanel cycleId={cycle.id} />
          </div>
        </div>
      )}
      <IssuesScreen key={cycle.id} embedded title={c.name} scope={{ cycleId: cycle.id, teamId: team.id }} hide={["cycle", "team"]} memoryKey={`cycle-${team.id}`} defaults={{ layout: "board" }} create={{ teamId: team.id, cycleId: c.completedAt ? undefined : cycle.id }} />
      {completing && <CompleteCycle cycle={c} onClose={() => setCompleting(false)} />}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="pj-stat">
      <div className="pj-stat-value">
        {value}
        {sub && <span className="pj-stat-sub">{sub}</span>}
      </div>
      {label && <div className="pj-stat-label">{label}</div>}
    </div>
  );
}

function Burnup({ data, t }: { data: { day: string; scope: number; completed: number }[]; t: PT }) {
  const w = 520;
  const h = 140;
  const max = Math.max(1, ...data.map((d) => d.scope));
  const px = (i: number) => (i / Math.max(1, data.length - 1)) * (w - 20) + 10;
  const py = (v: number) => h - 16 - (v / max) * (h - 30);
  const line = (k: "scope" | "completed") => data.map((d, i) => `${i ? "L" : "M"}${px(i).toFixed(1)},${py(d[k]).toFixed(1)}`).join(" ");
  return (
    <figure className="pj-burnup">
      <figcaption className="pj-prop-label">{t("cy.burnup")}</figcaption>
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={t("cy.burnup")}>
        <line x1="10" x2={w - 10} y1={h - 16} y2={h - 16} className="pj-axis" />
        <path d={line("scope")} className="pj-line-scope" />
        <path d={`${line("completed")} L${px(data.length - 1)},${h - 16} L10,${h - 16} Z`} className="pj-area-done" />
        <path d={line("completed")} className="pj-line-done" />
        <text x="10" y={h - 2} className="pj-axis-label">
          {data[0].day.slice(5)}
        </text>
        <text x={w - 10} y={h - 2} textAnchor="end" className="pj-axis-label">
          {data[data.length - 1].day.slice(5)}
        </text>
      </svg>
      <div className="pj-legend">
        <span>
          <i className="pj-legend-scope" />
          {t("cy.scope")}
        </span>
        <span>
          <i className="pj-legend-done" />
          {t("cy.done")}
        </span>
      </div>
    </figure>
  );
}

function CompleteCycle({ cycle, onClose }: { cycle: Cycle; onClose: () => void }) {
  const { t } = useT();
  const L = useLookups();
  const next = L.b.cycles.filter((c) => c.teamId === cycle.teamId && c.id !== cycle.id && !c.completedAt && c.endsOn >= L.b.today);
  const [to, setTo] = useState<string>(next[0]?.id ?? "");
  const open = cycle.progress.total - cycle.progress.completed;
  const run = async () => {
    try {
      await api(`cycles/${cycle.id}/complete`, { method: "POST", body: { moveTo: to || null } });
      await loadBoot();
      invalidateAll();
      onClose();
    } catch (e) {
      toast(errorText(e, t), "error");
    }
  };
  return (
    <Modal onClose={onClose} label={t("cy.complete")} width={440}>
      <div className="pj-form">
        <h2>{t("cy.complete")}</h2>
        <label className="pj-field">
          <span>{t("cy.completeHint", { n: open })}</span>
          <select className="pj-select" value={to} onChange={(e) => setTo(e.target.value)}>
            {next.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name || t("cy.name", { n: c.number })} ({c.startsOn})
              </option>
            ))}
            <option value="">{t("cy.noNext")}</option>
          </select>
        </label>
        <div className="pj-row-end">
          <button type="button" className="pj-btn" onClick={onClose}>
            {t("c.cancel")}
          </button>
          <button type="button" className="pj-btn pj-btn-primary" onClick={() => void run()}>
            {t("cy.complete")}
          </button>
        </div>
      </div>
    </Modal>
  );
}


