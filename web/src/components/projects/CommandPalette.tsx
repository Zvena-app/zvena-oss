"use client";

// Projects' command palette (/; ⌘K is zvena's own search): go anywhere, act on the selected or open
// issues (status, priority, assignee, labels, project, cycle, due date…),
// create things, and search issues on the server as you type. Plus the
// keyboard shortcuts help (?).

import { useEffect, useMemo, useState } from "react";
import { Archive, ArrowRight, Box, CalendarDays, CircleUser, Copy, Gauge, Inbox, Layers, Link2, ListTodo, Map as MapIcon, Moon, Plus, RefreshCcw, Search, Settings, Tag, Trash2, UserCircle2, Users } from "lucide-react";
import { ui, openCreate } from "./app-state";
import { api, useLookups } from "./data";
import { Glyph, PriorityIcon, ProjectGlyph, StatusIcon } from "./icons";
import { useT } from "./i18n";
import { copy, deleteIssues, issueUrl, PropPicker, useApply, type PropKind } from "./pickers";
import { href, navigate } from "./router";
import { Kbd, Menu, Modal, modKey, type MenuItem } from "./ui";

export function CommandPalette() {
  const { t } = useT();
  const L = useLookups();
  const apply = useApply();
  const state = ui.get();
  const issues = state.palette?.issues ?? state.target;
  const [q, setQ] = useState("");
  const [sub, setSub] = useState<PropKind | null>(null);
  const [found, setFound] = useState<{ id: string; identifier: string; title: string; statusId: string }[]>([]);
  const close = () => ui.update((s) => ({ ...s, palette: null }));

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      void api<{ issues: { id: string; identifier: string; title: string; statusId: string }[] }>("search", { query: { q: term }, signal: ctl.signal })
        .then((r) => setFound(r.issues.slice(0, 8)))
        .catch(() => undefined);
    }, 150);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [q]);

  const items = useMemo<MenuItem[]>(() => {
    const go = (to: string) => () => navigate(to);
    const list: MenuItem[] = [];
    const sel = t("cmd.selection");
    if (issues.length && L.canEdit) {
      const group = issues.length === 1 ? `${t("cmd.issue")} · ${issues[0].identifier}` : `${sel} · ${issues.length}`;
      const prop = (kind: PropKind, label: string, icon: React.ReactNode, hotkey?: string): MenuItem => ({ id: `p-${kind}`, label, icon, group, keepOpen: true, hint: hotkey, right: hotkey ? <Kbd>{hotkey}</Kbd> : undefined, onSelect: () => setSub(kind) });
      list.push(
        prop("status", t("cmd.setStatus"), <StatusIcon category="started" color="currentColor" fraction={0.5} />, "S"),
        prop("priority", t("cmd.setPriority"), <PriorityIcon priority={2} />, "P"),
        prop("assignee", t("cmd.assign"), <UserCircle2 size={15} />, "A"),
        { id: "me", label: t("i.assignMe"), icon: <CircleUser size={15} />, group, right: <Kbd>I</Kbd>, onSelect: () => void apply(issues, { assigneeId: L.b.me.id }) },
        prop("labels", t("cmd.labels"), <Tag size={15} />, "L"),
        prop("project", t("cmd.project"), <Box size={15} />),
        prop("due", t("cmd.due"), <CalendarDays size={15} />, "D")
      );
      if (issues.every((i) => i.teamId === issues[0].teamId)) {
        if (L.team.get(issues[0].teamId)?.cyclesEnabled) list.push(prop("cycle", t("cmd.cycle"), <RefreshCcw size={14} />));
        if (L.team.get(issues[0].teamId)?.estimates !== "none") list.push(prop("estimate", t("cmd.estimate"), <Gauge size={14} />, "E"));
      }
      list.push(prop("team", t("i.moveTeam"), <Users size={15} />));
      if (issues.length === 1) {
        list.push(
          { id: "copyId", label: t("i.copyId"), icon: <Copy size={15} />, group, onSelect: () => copy(issues[0].identifier, t) },
          { id: "copyLink", label: t("i.copyLink"), icon: <Link2 size={15} />, group, onSelect: () => copy(issueUrl(issues[0]), t) }
        );
      }
      list.push(
        { id: "archive", label: t("i.archive"), icon: <Archive size={15} />, group, onSelect: () => void apply(issues, { archived: true }) },
        { id: "delete", label: t("i.delete"), icon: <Trash2 size={15} />, group, danger: true, onSelect: () => deleteIssues(issues, t) }
      );
    }
    const act = t("cmd.actions");
    if (L.canEdit) {
      list.push(
        { id: "new", label: t("nav.newIssue"), icon: <Plus size={15} />, group: act, right: <Kbd>C</Kbd>, onSelect: () => openCreate({}) },
        { id: "newProject", label: t("pr.new"), icon: <Box size={15} />, group: act, onSelect: go("/projects") },
        { id: "newTeam", label: t("nav.newTeam"), icon: <Users size={15} />, group: act, onSelect: go("/settings/teams?new=1") }
      );
    }
    list.push({
      id: "theme",
      label: t("cmd.theme"),
      icon: <Moon size={15} />,
      group: act,
      onSelect: toggleTheme,
    });
    const nav = t("cmd.navigation");
    list.push(
      { id: "g-inbox", label: t("nav.inbox"), icon: <Inbox size={15} />, group: nav, right: <Kbd>G I</Kbd>, onSelect: go("/inbox") },
      { id: "g-my", label: t("nav.myIssues"), icon: <CircleUser size={15} />, group: nav, right: <Kbd>G M</Kbd>, onSelect: go("/my-issues") },
      { id: "g-all", label: t("nav.allIssues"), icon: <ListTodo size={15} />, group: nav, right: <Kbd>G A</Kbd>, onSelect: go("/issues") },
      { id: "g-projects", label: t("nav.projects"), icon: <Box size={15} />, group: nav, right: <Kbd>G P</Kbd>, onSelect: go("/projects") },
      { id: "g-roadmap", label: t("nav.roadmap"), icon: <MapIcon size={15} />, group: nav, right: <Kbd>G R</Kbd>, onSelect: go("/roadmap") },
      { id: "g-views", label: t("nav.views"), icon: <Layers size={15} />, group: nav, right: <Kbd>G V</Kbd>, onSelect: go("/views") },
      { id: "g-settings", label: t("nav.settings"), icon: <Settings size={15} />, group: nav, right: <Kbd>G S</Kbd>, onSelect: go("/settings") }
    );
    for (const tm of L.b.teams) {
      list.push(
        { id: `t-${tm.id}`, label: `${tm.name} · ${t("nav.issues")}`, keywords: tm.key, icon: <Glyph icon={tm.icon} color={tm.color} text={tm.name} size={16} />, group: nav, onSelect: go(`/team/${tm.key}/issues`) },
        { id: `tb-${tm.id}`, label: `${tm.name} · ${t("nav.backlog")}`, keywords: tm.key, icon: <Glyph icon={tm.icon} color={tm.color} text={tm.name} size={16} />, group: nav, onSelect: go(`/team/${tm.key}/backlog`) }
      );
      if (tm.cyclesEnabled) list.push({ id: `tc-${tm.id}`, label: `${tm.name} · ${t("nav.cycles")}`, keywords: tm.key, icon: <RefreshCcw size={14} />, group: nav, onSelect: go(`/team/${tm.key}/cycles`) });
    }
    for (const p of L.b.projects) list.push({ id: `pr-${p.id}`, label: p.name, icon: <ProjectGlyph icon={p.icon} color={p.color} />, group: t("nav.projects"), onSelect: go(`/project/${p.id}`) });
    for (const v of L.b.views) list.push({ id: `v-${v.id}`, label: v.name, icon: <Layers size={15} />, group: t("nav.views"), onSelect: go(`/view/${v.id}`) });
    if (q.trim().length >= 2 && found.length) {
      for (const i of found) {
        const s = L.status.get(i.statusId);
        list.unshift({
          id: `i-${i.id}`,
          label: `${i.identifier} ${i.title}`,
          icon: s ? <StatusIcon category={s.category} color={s.color} fraction={L.fraction(s.id)} /> : undefined,
          group: t("s.issues"),
          always: true,
          onSelect: go(`/issue/${i.identifier}`),
        });
      }
    }
    if (q.trim())
      list.push({ id: "search", label: t("cmd.searchFor", { q: q.trim() }), icon: <Search size={15} />, group: t("nav.search"), always: true, onSelect: () => navigate(href("/search", { q: q.trim() })) });
    return list;
  }, [issues, L, t, apply, found, q]);

  return (
    <Modal onClose={close} label={t("k.palette")} width={640} className="pj-palette" top>
      {sub && issues.length ? (
        <div className="pj-palette-sub">
          <div className="pj-menu-group">
            {issues.length === 1 ? issues[0].identifier : t("i.selected", { n: issues.length })} <ArrowRight size={12} />
          </div>
          <PropPicker kind={sub} issues={issues} onClose={close} />
        </div>
      ) : (
        <Menu items={items} onClose={close} placeholder={t("cmd.placeholder")} query={q} onQuery={setQ} />
      )}
    </Modal>
  );
}

/** Light / dark for this browser (the same setting zvena's pages read before paint). */
function toggleTheme(): void {
  const root = document.documentElement;
  const dark = !root.classList.contains("dark");
  root.classList.toggle("dark", dark);
  root.style.setProperty("color-scheme", dark ? "dark" : "light");
  try {
    const s = JSON.parse(localStorage.getItem("zvena-settings") || "{}") as Record<string, unknown>;
    localStorage.setItem("zvena-settings", JSON.stringify({ ...s, theme: dark ? "dark" : "light" }));
  } catch {
    // private mode: this tab only
  }
}

export function ShortcutsHelp() {
  const { t } = useT();
  const close = () => ui.update((s) => ({ ...s, help: false }));
  const mod = modKey();
  const groups: [string, [string, string][]][] = [
    [
      t("k.general"),
      [
        ["/", t("k.palette")],
        [`${mod} K`, t("k.search")],
        ["C", t("k.create")],
        ["?", t("k.help")],
        [`${mod} Enter`, t("k.submit")],
        [`${mod} Z`, t("k.undo")],
        ["Esc", t("k.close")],
      ],
    ],
    [
      t("k.nav"),
      [
        ["G I", t("k.goInbox")],
        ["G M", t("k.goMy")],
        ["G A", t("k.goAll")],
        ["G P", t("k.goProjects")],
        ["G C", t("k.goCycles")],
        ["G R", t("k.goRoadmap")],
        ["G V", t("k.goViews")],
        ["G T", t("k.goTeam")],
        ["G B", t("k.goBacklog")],
        ["G S", t("k.goSettings")],
      ],
    ],
    [
      t("k.list"),
      [
        ["J / K", t("k.move")],
        ["Click / Space", t("i.peek")],
        ["Enter / O", t("i.fullPage")],
        ["X", t("k.select")],
        ["⇧ J / K", t("k.extend")],
        [`${mod} A`, t("k.selectAll")],
        ["F", t("k.filter")],
        [`${mod} B`, t("k.layout")],
      ],
    ],
    [
      t("k.issue"),
      [
        ["S", t("k.status")],
        ["P", t("k.priority")],
        ["A", t("k.assign")],
        ["I", t("k.assignMe")],
        ["L", t("k.labels")],
        ["D", t("k.due")],
        ["E", t("k.estimate")],
        ["⇧ P", t("k.project")],
        ["⇧ C", t("k.cycle")],
        ["⇧ M", t("k.milestone")],
        [`${mod} .`, t("k.copyId")],
        [`${mod} ⇧ ,`, t("k.copyLink")],
        [`${mod} ⌫`, t("i.delete")],
      ],
    ],
    [
      t("tr.title"),
      [
        ["1", t("tr.accept")],
        ["2", t("tr.duplicate")],
        ["3", t("tr.decline")],
        ["H", t("tr.snooze")],
      ],
    ],
    [
      t("n.title"),
      [
        ["J / K", t("k.move")],
        ["U", t("k.unread")],
        ["⌫", t("k.archive")],
      ],
    ],
  ];
  return (
    <Modal onClose={close} label={t("k.title")} width={720}>
      <div className="pj-help">
        <h2>{t("k.title")}</h2>
        <div className="pj-help-grid">
          {groups.map(([title, rows]) => (
            <section key={title}>
              <h3>{title}</h3>
              {rows.map(([k, label]) => (
                <div key={k} className="pj-help-row">
                  <span>{label}</span>
                  <span className="pj-help-keys">
                    {k.split(" ").map((x, i) => (
                      <Kbd key={i}>{x}</Kbd>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </Modal>
  );
}
