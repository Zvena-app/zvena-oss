"use client";

// An issue screen: My issues, All issues, a team's issues and backlog, a
// project's or cycle's issues, a saved view, the archive. Filters, display
// and paging run on the server; the URL keeps the state; keyboard, selection,
// bulk changes, context menus and drag and drop all save to the server.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Archive, Bookmark, Box, CalendarDays, Calendar, CircleSlash, Columns3, LayoutList, Plus, RefreshCcw, Tag, Trash2, UserCircle2, Users } from "lucide-react";
import { EmptyStart, SelectionAction, SelectionBar, ViewSwitcher, type ViewOption } from "@/components/zvena/ds";
import { displayFromParams, displayToParams, filterFromParams, filterToParams, isEmptyFilter } from "@/lib/projects/filter";
import { DEFAULT_DISPLAY, type Grouping, type Issue, type IssueDisplay, type IssueFilter, type IssuePage, type Layout } from "@/lib/projects/types";
import { openCreate, remember, setTarget, typing, ui } from "./app-state";
import { api, errorText, invalidateAll, loadBoot, offerUndo, saveIssue, setCached, toast, useLookups, useQuery } from "./data";
import { AskButton, DisplayButton, FilterButton, FilterChips, type FilterKey } from "./FilterMenu";
import { allGroupKeys, groupInfo, sortGroups, type GroupInfo } from "./groups";
import { useT } from "./i18n";
import { BoardView, CalendarView, ListView, type ListHandlers, type ViewGroup } from "./IssueList";
import { deleteIssues, IssueContextMenu, PropPicker, useApply, type PropKind } from "./pickers";
import { copyIssueRefs, navigate, replaceParams, setParams, useLoc } from "./router";
import { ErrorState, Kbd, LoadingRows, Modal, overlays, Popover, Toggle, type Anchor } from "./ui";
import { touchedLast } from "./drag";
import { PriorityIcon, StatusIcon } from "./icons";

export interface IssuesScreenProps {
  title: ReactNode;
  icon?: ReactNode;
  /** Fixed conditions of the screen (not shown as chips). */
  base?: IssueFilter;
  scope?: { teamId?: string; projectId?: string; cycleId?: string };
  hide?: FilterKey[];
  defaults?: Partial<IssueDisplay>;
  tabs?: ReactNode;
  create?: Record<string, unknown>;
  view?: { id: string; name: string; canSave: boolean; filters: IssueFilter; display: Partial<IssueDisplay> };
  memoryKey: string;
  embedded?: boolean;
  headerExtra?: ReactNode;
}

const PAGE = 50;

export function IssuesScreen(props: IssuesScreenProps) {
  const { t } = useT();
  const L = useLookups();
  const loc = useLoc();
  const apply = useApply();
  const baseDisplay: IssueDisplay = useMemo(() => {
    const remembered = remember<Partial<IssueDisplay>>(`display:${props.memoryKey}`);
    return { ...DEFAULT_DISPLAY, ...props.defaults, ...(props.view?.display ?? {}), ...(remembered ?? {}) };
    // The remembered display is read once per screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.memoryKey, props.view?.id]);

  // The view's own filter applies until the URL says otherwise.
  const paramsKey = loc.params.toString();
  const viewFilters = props.view?.filters;
  const { urlHasFilter, userFilter, d } = useMemo(() => {
    const params = new URLSearchParams(paramsKey);
    const has = [...params.keys()].some((k) => !["ws", "peek", "layout", "group", "order", "completed", "sub", "empty", "props", "month"].includes(k));
    return { urlHasFilter: has, userFilter: has || !viewFilters ? filterFromParams(params) : viewFilters, d: displayFromParams(params, baseDisplay) };
  }, [paramsKey, viewFilters, baseDisplay]);
  const baseKey = JSON.stringify(props.base ?? {});
  const filter: IssueFilter = useMemo(() => ({ ...userFilter, ...(JSON.parse(baseKey) as IssueFilter) }), [userFilter, baseKey]);
  const scopeKey = JSON.stringify(props.scope ?? {});
  const month = loc.params.get("month") ?? L.b.today.slice(0, 7);

  const setFilter = (f: IssueFilter) => {
    const p = filterToParams(f);
    if (props.view && isEmptyFilter(f)) p.set("filtered", "0");
    displayToParams(d, baseDisplay, p);
    replaceParams(p);
  };
  const setDisplay = (nd: IssueDisplay) => {
    remember(`display:${props.memoryKey}`, { layout: nd.layout, group: nd.group, order: nd.order, completed: nd.completed, subIssues: nd.subIssues, emptyGroups: nd.emptyGroups, props: nd.props });
    const p = filterToParams(urlHasFilter || !props.view ? userFilter : {});
    displayToParams(nd, baseDisplay, p);
    if (nd.layout === "calendar" && loc.params.get("month")) p.set("month", loc.params.get("month") as string);
    replaceParams(p);
  };
  const resetDisplay = () => {
    remember(`display:${props.memoryKey}`, {});
    const base = { ...DEFAULT_DISPLAY, ...props.defaults, ...(props.view?.display ?? {}) };
    const p = filterToParams(userFilter);
    displayToParams(base, baseDisplay, p);
    replaceParams(p);
  };

  // --- Data ---
  const today = L.b.today;
  const queryString = useMemo(() => {
    const scope = JSON.parse(scopeKey) as NonNullable<IssuesScreenProps["scope"]>;
    const q = new URLSearchParams();
    q.set("filter", JSON.stringify(filter));
    q.set("display", JSON.stringify(d));
    q.set("limit", String(d.layout === "calendar" ? 200 : PAGE));
    q.set("today", today);
    if (scope.teamId) q.set("inTeam", scope.teamId);
    if (scope.projectId) q.set("inProject", scope.projectId);
    if (scope.cycleId) q.set("inCycle", scope.cycleId);
    if (d.layout === "calendar") {
      q.set("dueFrom", `${month}-01`);
      q.set("dueTo", `${month}-31`);
    }
    return q.toString();
  }, [filter, d, today, scopeKey, month]);
  const key = `issues:${queryString}`;
  const { data, error, loading, reload } = useQuery<IssuePage>(key, () => api<IssuePage>("issues", { query: new URLSearchParams(queryString) }));

  const scopeTeamId = props.scope?.teamId;
  const filterTeams = filter.team;
  const allTeams = L.b.teams;
  const scopeTeams = useMemo(() => {
    if (scopeTeamId) return [scopeTeamId];
    if (filterTeams?.length) return filterTeams;
    return allTeams.filter((x) => x.isMember || !x.private).map((x) => x.id);
  }, [scopeTeamId, filterTeams, allTeams]);

  const newIssue = () => openCreate({ ...(props.create ?? {}), teamId: props.scope?.teamId ?? (props.create?.teamId as string) ?? scopeTeams[0] });
  const views: ViewOption<Layout>[] = [
    { id: "list", label: t("d.list"), icon: <LayoutList size={14} /> },
    { id: "board", label: t("d.board"), icon: <Columns3 size={14} /> },
    { id: "calendar", label: t("d.calendar"), icon: <Calendar size={14} /> },
  ];

  const groups: ViewGroup[] = useMemo(() => {
    if (!data) return [];
    const grouping: Grouping = d.layout === "calendar" ? "none" : d.group;
    const byKey = new Map(data.groups.map((g) => [g.key, g]));
    let keys = data.groups.map((g) => g.key);
    if (grouping !== "none" && (d.emptyGroups || d.layout === "board")) {
      const all = allGroupKeys(L, grouping, scopeTeams);
      // A board shows every column unless filters hide it; a list only with "show empty groups".
      const shown = d.layout === "board" && !d.emptyGroups ? all.filter((k) => byKey.has(k) || grouping === "status") : all;
      keys = [...new Set([...keys, ...shown])];
      if (grouping === "status" && filter.category?.length) keys = keys.filter((k) => byKey.has(k) || filter.category?.includes(k.split(":")[0] as never));
      if (grouping === "status" && d.completed === "none") keys = keys.filter((k) => byKey.has(k) || !/^(completed|canceled):/.test(k));
    }
    const infos = sortGroups(
      keys.map((k) => groupInfo(L, grouping, k, t)),
      d.layout === "board"
    );
    return infos.map((info) => {
      const g = byKey.get(info.key);
      return { info, count: g?.count ?? 0, items: g?.items ?? [], cursor: g?.cursor ?? null };
    });
  }, [data, d.layout, d.group, d.emptyGroups, d.completed, L, t, scopeTeams, filter.category]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  // --- Selection and focus ---
  const [picked, setSelected] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const anchorId = useRef<string | null>(null);
  // Only issues still in the list stay selected.
  const selected = useMemo(() => {
    const ids = new Set(flat.map((i) => i.id));
    return new Set([...picked].filter((id) => ids.has(id)));
  }, [picked, flat]);
  const targetIssues = useMemo(() => {
    if (selected.size) return flat.filter((i) => selected.has(i.id));
    const f = flat.find((i) => i.id === focused);
    return f ? [f] : [];
  }, [selected, focused, flat]);
  useEffect(() => {
    setTarget(targetIssues);
  }, [targetIssues]);
  useEffect(() => () => setTarget([]), []);

  const select = useCallback(
    (issue: Issue, e: MouseEvent | { shiftKey: boolean }) => {
      setSelected((s) => {
        const next = new Set(s);
        if (e.shiftKey && anchorId.current) {
          const a = flat.findIndex((i) => i.id === anchorId.current);
          const b = flat.findIndex((i) => i.id === issue.id);
          if (a >= 0 && b >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(flat[i].id);
        } else if (next.has(issue.id)) next.delete(issue.id);
        else next.add(issue.id);
        anchorId.current = issue.id;
        return next;
      });
    },
    [flat]
  );

  const [ctxMenu, setCtxMenu] = useState<{ anchor: Anchor; issues: Issue[]; touch?: boolean } | null>(null);
  // Picking started from a long press (touch): the bar shows from the first issue, with its ✕ to stop.
  const [touchPick, setTouchPick] = useState(false);
  if (touchPick && selected.size === 0) setTouchPick(false);
  const [picker, setPicker] = useState<{ anchor: Anchor; kind: PropKind; issues: Issue[] } | null>(null);
  const [saveView, setSaveView] = useState(false);

  // A click opens the issue on the side (the list stays); Enter opens the full page.
  const open = useCallback((issue: Issue) => navigate(`/issue/${issue.identifier}`), []);
  const peek = useCallback((issue: Issue) => setParams({ peek: issue.identifier }, { replace: false }), []);

  const handlers: ListHandlers = {
    selected,
    focused,
    canEdit: L.canEdit,
    onOpen: (issue) => {
      setFocused(issue.id);
      peek(issue);
    },
    onSelect: (issue, e) => select(issue, e),
    onFocus: (issue) => setFocused(issue.id),
    onMore: (issue, anchor) => {
      const issues = selected.has(issue.id) ? flat.filter((i) => selected.has(i.id)) : [issue];
      setCtxMenu({ anchor, issues, touch: touchedLast() });
    },
    onContext: (issue, e) => {
      e.preventDefault();
      const issues = selected.has(issue.id) ? flat.filter((i) => selected.has(i.id)) : [issue];
      setCtxMenu({ anchor: { x: e.clientX, y: e.clientY }, issues });
    },
    onCreate: (g: GroupInfo) => {
      const teamId = props.scope?.teamId ?? (props.create?.teamId as string | undefined) ?? scopeTeams[0];
      openCreate({ ...(props.create ?? {}), teamId, ...g.create(teamId ?? "") });
    },
    onLoadMore: async (g) => {
      if (!g.cursor) return;
      const q = new URLSearchParams(queryString);
      q.set("inGroup", g.info.key);
      q.set("cursor", g.cursor);
      try {
        const page = await api<IssuePage>("issues", { query: q });
        const more = page.groups[0];
        setCached(key, (v) => {
          const p = v as IssuePage;
          return { ...p, groups: p.groups.map((x) => (x.key === g.info.key ? { ...x, items: [...x.items, ...more.items.filter((i) => !x.items.some((y) => y.id === i.id))], cursor: more.cursor } : x)) };
        });
      } catch (e) {
        toast(errorText(e, t), "error");
      }
    },
    onDrop: (issueId, group, before, after) => {
      const issue = flat.find((i) => i.id === issueId);
      if (!issue) return;
      const patch = group.move(issue);
      if (!patch) {
        toast(t("c.forbidden"), "error");
        return;
      }
      const manual = d.order === "manual";
      if (manual && before !== issueId && after !== issueId) patch.position = { before, after };
      if (!Object.keys(patch).length) return;
      // Move the card at once; the server's answer settles it.
      setCached(key, (v) => {
        const p = v as IssuePage;
        const moved = { ...issue, ...(patch.statusId ? { statusId: patch.statusId as string } : {}) };
        const groupsNow = p.groups.map((x) => ({ ...x, items: x.items.filter((i) => i.id !== issueId), count: x.items.some((i) => i.id === issueId) ? x.count - 1 : x.count }));
        let target = groupsNow.find((x) => x.key === group.key);
        if (!target) {
          target = { key: group.key, count: 0, items: [], cursor: null };
          groupsNow.push(target);
        }
        const at = after ? target.items.findIndex((i) => i.id === after) : -1;
        target.items = at >= 0 ? [...target.items.slice(0, at), moved, ...target.items.slice(at)] : [...target.items, moved];
        target.count += 1;
        return { ...p, groups: groupsNow };
      });
      const prev: Record<string, unknown> = {};
      for (const k of Object.keys(patch)) if (k !== "position" && k in issue) prev[k] = (issue as unknown as Record<string, unknown>)[k];
      if ("teamId" in patch) prev.teamId = issue.teamId;
      void saveIssue(issueId, patch, {}, (e) => toast(errorText(e, t), "error")).then((ok) => {
        if (ok && Object.keys(prev).length) offerUndo(`${issue.identifier} · ${t("i.moved")}`, () => void saveIssue(issueId, prev, prev as Partial<Issue>));
      });
    },
  };

  // --- Keyboard ---
  const stateRef = useRef({ flat, focused, selected, targetIssues, d });
  useLayoutEffect(() => {
    stateRef.current = { flat, focused, selected, targetIssues, d };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || overlays.get().length || typing(e) || ui.get().create || ui.get().palette) return;
      const s = stateRef.current;
      const idx = s.flat.findIndex((i) => i.id === s.focused);
      const move = (n: number) => {
        const next = s.flat[Math.max(0, Math.min(s.flat.length - 1, (idx < 0 ? (n > 0 ? -1 : s.flat.length) : idx) + n))];
        if (!next) return;
        setFocused(next.id);
        document.querySelector(`.pj-main [data-id="${next.id}"]`)?.scrollIntoView({ block: "nearest" });
        // With the side panel open, it follows the focus.
        if (new URLSearchParams(location.search).get("peek")) setParams({ peek: next.identifier });
        if (e.shiftKey) select(next, { shiftKey: false });
      };
      const mod = e.metaKey || e.ctrlKey;
      const anchorEl = (): Anchor => (s.focused ? (document.querySelector(`.pj-main [data-id="${s.focused}"]`) as HTMLElement | null) : null) ?? { x: window.innerWidth / 2 - 120, y: 160 };
      const pick = (kind: PropKind) => {
        if (!s.targetIssues.length || !L.canEdit) return;
        e.preventDefault();
        setPicker({ anchor: anchorEl(), kind, issues: s.targetIssues });
      };
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelected(new Set(s.flat.map((i) => i.id)));
        return;
      }
      if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setDisplay({ ...s.d, layout: s.d.layout === "board" ? "list" : "board" });
        return;
      }
      // Linear's copy shortcuts: ⌘. the identifiers, ⌘⇧, the links.
      if (mod && (e.key === "." || (e.shiftKey && (e.key === "," || e.key === "<"))) && s.targetIssues.length) {
        e.preventDefault();
        const what = e.key === "." ? "id" : "link";
        void copyIssueRefs(s.targetIssues, what).then((ok) => toast(ok ? (what === "id" ? t("k.copiedId", { ids: s.targetIssues.map((i) => i.identifier).join(", ") }) : t("k.copiedLink")) : t("c.copyFailed"), ok ? "success" : "error"));
        return;
      }
      if (mod && e.key === "Backspace" && s.targetIssues.length && L.canEdit) {
        e.preventDefault();
        deleteIssues(s.targetIssues, t, () => setSelected(new Set()));
        return;
      }
      if (mod || e.altKey) return;
      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          move(1);
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          move(-1);
          break;
        case "J":
        case "K": {
          // Shift+J/K grows the selection from the focused issue.
          e.preventDefault();
          const cur = s.flat[idx];
          if (cur && !s.selected.has(cur.id)) select(cur, { shiftKey: false });
          move(e.key === "J" ? 1 : -1);
          break;
        }
        case "P":
          pick("project");
          break;
        case "C":
          pick("cycle");
          break;
        case "M":
          pick("milestone");
          break;
        case "Enter":
        case "o": {
          const it = s.flat[idx];
          if (it) {
            e.preventDefault();
            open(it);
          }
          break;
        }
        case " ": {
          const it = s.flat[idx];
          if (it) {
            e.preventDefault();
            setParams({ peek: new URLSearchParams(location.search).get("peek") === it.identifier ? null : it.identifier });
          }
          break;
        }
        case "x": {
          const it = s.flat[idx];
          if (it) {
            e.preventDefault();
            select(it, { shiftKey: false });
          }
          break;
        }
        case "Escape":
          if (s.selected.size) {
            e.preventDefault();
            setSelected(new Set());
          }
          break;
        case "s":
          pick("status");
          break;
        case "p":
          pick("priority");
          break;
        case "a":
          pick("assignee");
          break;
        case "l":
          pick("labels");
          break;
        case "d":
          pick("due");
          break;
        case "e":
          pick("estimate");
          break;
        case "i":
          if (s.targetIssues.length && L.canEdit) {
            e.preventDefault();
            void apply(s.targetIssues, { assigneeId: L.b.me.id });
          }
          break;
        case "f":
          e.preventDefault();
          (document.querySelector(".pj-main [data-filter-button]") as HTMLElement | null)?.click();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // setDisplay depends on the URL, read fresh through stateRef/location.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [L, select, open, apply, t]);

  // --- Render ---
  const grouped = (d.layout === "calendar" ? "none" : d.group) !== "none";
  const empty = data && data.total === 0;
  const filtered = !isEmptyFilter(userFilter);
  const viewDirty = Boolean(props.view) && (urlHasFilter || JSON.stringify({ ...DEFAULT_DISPLAY, ...props.view?.display }) !== JSON.stringify(d));
  const body = error ? (
    <ErrorState onRetry={reload} />
  ) : loading || !data ? (
    <LoadingRows />
  ) : d.layout === "calendar" ? (
    <CalendarView
      issues={flat}
      month={month}
      setMonth={(m) => setParams({ month: m })}
      h={{ ...handlers, onDue: (id, day) => void saveIssue(id, { dueDate: day }, { dueDate: day }, (e) => toast(errorText(e, t), "error")) }}
    />
  ) : empty && (!grouped || (d.layout === "list" && !d.emptyGroups)) ? (
    // An empty list offers the next step (design system: EmptyStart).
    filtered ? (
      <EmptyStart title={t("i.emptyFiltered")} starts={[{ id: "clear", label: t("f.clear"), icon: <CircleSlash size={16} />, tint: "var(--ui-tint-stone)", onClick: () => setFilter({}) }]} />
    ) : (
      <EmptyStart
        title={L.canEdit ? t("i.emptyStart") : t("i.empty")}
        hint={L.canEdit ? t("i.emptyHint") : undefined}
        starts={
          L.canEdit
            ? [
                { id: "new", label: t("nav.newIssue"), icon: <Plus size={16} />, tint: "var(--ui-tint-orange)", keys: ["C"], onClick: newIssue },
                { id: "project", label: t("pr.new"), icon: <Box size={16} />, tint: "var(--ui-tint-indigo)", onClick: () => navigate("/projects") },
                { id: "team", label: t("i.inviteTeam"), icon: <Users size={16} />, tint: "var(--ui-tint-green)", href: `/team?ws=${encodeURIComponent(L.b.ws.id)}` },
              ]
            : []
        }
      />
    )
  ) : d.layout === "board" ? (
    <BoardView groups={groups} d={d} h={handlers} manual={d.order === "manual"} />
  ) : (
    <ListView groups={groups} d={d} h={handlers} grouped={grouped} manual={d.order === "manual"} />
  );

  return (
    <div className={`pj-screen ${props.embedded ? "pj-screen-embedded" : ""}`} data-layout={d.layout}>
      {/* ViewSwitcher (⌘1–⌘3) sits on the screen's top line, next to its name. */}
      {!props.embedded && (
        <header className="pj-head">
          <div className="pj-head-title">
            {props.icon}
            <h1>{props.title}</h1>
            {data && <span className="pj-head-count">{data.total}</span>}
          </div>
          {props.tabs}
          <ViewSwitcher views={views} value={d.layout} onChange={(v) => setDisplay({ ...d, layout: v })} hotkeys label={t("d.layout")} />
          <div className="pj-head-actions">
            {props.headerExtra}
            {L.canEdit && (
              <button type="button" className="pj-btn pj-btn-sm" title={`${t("nav.newIssue")} (C)`} onClick={newIssue}>
                <Plus size={14} />
                <span className="pj-hide-sm">{t("nav.newIssue")}</span>
              </button>
            )}
          </div>
        </header>
      )}
      <div className="pj-toolbar-row">
        <FilterButton f={userFilter} set={setFilter} hide={props.hide} />
        <AskButton apply={(f) => setFilter(f)} />
        <FilterChips f={userFilter} set={setFilter} hide={props.hide} />
        <div className="pj-toolbar-end">
          {(viewDirty || (!props.view && (filtered || JSON.stringify(d) !== JSON.stringify({ ...DEFAULT_DISPLAY, ...props.defaults })))) && (
            <button type="button" className="pj-btn pj-btn-sm pj-btn-ghost" onClick={() => setSaveView(true)}>
              <Bookmark size={14} />
              <span className="pj-hide-sm">{props.view?.canSave ? t("d.update") : t("d.save")}</span>
            </button>
          )}
          {props.embedded && <ViewSwitcher views={views} value={d.layout} onChange={(v) => setDisplay({ ...d, layout: v })} label={t("d.layout")} />}
          <DisplayButton d={d} set={setDisplay} onReset={resetDisplay} />
        </div>
      </div>
      <div className="pj-screen-body">{body}</div>
      {/* From two selected rows: bulk actions (design system: SelectionBar); one row edits with its own pills. */}
      {(selected.size >= 2 || (touchPick && selected.size > 0)) && L.canEdit && <BulkBar issues={flat.filter((i) => selected.has(i.id))} onClear={() => setSelected(new Set())} onPick={(kind, a) => setPicker({ anchor: a, kind, issues: flat.filter((i) => selected.has(i.id)) })} />}
      {ctxMenu && (
        <IssueContextMenu
          issues={ctxMenu.issues}
          anchor={ctxMenu.anchor}
          onClose={() => setCtxMenu(null)}
          onSelect={
            ctxMenu.touch && ctxMenu.issues.length === 1 && !selected.has(ctxMenu.issues[0].id)
              ? () => {
                  setTouchPick(true);
                  select(ctxMenu.issues[0], { shiftKey: false });
                }
              : undefined
          }
        />
      )}
      {picker && (
        <Popover anchor={picker.anchor} onClose={() => setPicker(null)} width={picker.kind === "due" ? 268 : 250} label={picker.kind}>
          <PropPicker kind={picker.kind} issues={picker.issues} onClose={() => setPicker(null)} />
        </Popover>
      )}
      {saveView && (
        <SaveViewDialog
          onClose={() => setSaveView(false)}
          existing={props.view?.canSave ? props.view : null}
          filters={urlHasFilter || !props.view ? userFilter : props.view.filters}
          display={d}
          scope={props.scope}
        />
      )}
    </div>
  );
}

function BulkBar({ issues, onClear, onPick }: { issues: Issue[]; onClear: () => void; onPick: (kind: PropKind, anchor: HTMLElement) => void }) {
  const { t } = useT();
  const apply = useApply();
  const L = useLookups();
  const sameTeam = issues.every((i) => i.teamId === issues[0]?.teamId);
  const act = (kind: PropKind, label: string, icon: ReactNode, keys?: string[]) => (
    <SelectionAction icon={icon} keys={keys} onClick={(e) => onPick(kind, e.currentTarget)}>
      {label}
    </SelectionAction>
  );
  return (
    <SelectionBar count={issues.length} onClear={onClear}>
      {act("status", t("f.status"), <StatusIcon category="started" color="currentColor" fraction={0.5} />, ["S"])}
      {act("priority", t("f.priority"), <PriorityIcon priority={2} size={14} />, ["P"])}
      {act("assignee", t("f.assignee"), <UserCircle2 size={14} />, ["A"])}
      {act("labels", t("f.labels"), <Tag size={14} />, ["L"])}
      {act("project", t("f.project"), <Box size={14} />)}
      {sameTeam && L.team.get(issues[0].teamId)?.cyclesEnabled && act("cycle", t("f.cycle"), <RefreshCcw size={14} />)}
      {act("due", t("f.due"), <CalendarDays size={14} />, ["D"])}
      <SelectionAction icon={<Archive size={14} />} onClick={() => void apply(issues, { archived: true }).then(onClear)}>
        {t("i.archive")}
      </SelectionAction>
      <SelectionAction icon={<Trash2 size={14} />} tone="danger" keys={["⌘", "⌫"]} onClick={() => deleteIssues(issues, t, onClear)}>
        {t("i.delete")}
      </SelectionAction>
    </SelectionBar>
  );
}

function SaveViewDialog({
  onClose,
  existing,
  filters,
  display,
  scope,
}: {
  onClose: () => void;
  existing: { id: string; name: string } | null;
  filters: IssueFilter;
  display: IssueDisplay;
  scope?: { teamId?: string; projectId?: string };
}) {
  const { t } = useT();
  const L = useLookups();
  const [name, setName] = useState(existing?.name ?? "");
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async (asNew: boolean) => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const body = { name, filters, display, teamId: scope?.teamId ?? null, projectId: scope?.projectId ?? null, ...(asNew ? { shared } : {}) };
      const v = existing && !asNew ? await api<{ id: string }>(`views/${existing.id}`, { method: "PATCH", body }) : await api<{ id: string }>("views", { method: "POST", body });
      await loadBoot();
      invalidateAll();
      toast(t("v.saved"), "success");
      onClose();
      navigate(`/view/${v.id}`);
    } catch (e) {
      toast(errorText(e, t), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label={t("d.save")} width={440}>
      <form
        className="pj-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save(!existing);
        }}
      >
        <h2>{existing ? t("d.update") : t("d.save")}</h2>
        <input className="pj-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("v.name")} aria-label={t("v.name")} maxLength={80} />
        {!existing && L.canEdit && (
          <label className="pj-check-row">
            <Toggle on={shared} onChange={setShared} label={t("v.shared")} />
            <span>{t("v.shared")}</span>
          </label>
        )}
        <div className="pj-row-end">
          {existing && (
            <button type="button" className="pj-btn" disabled={busy} onClick={() => void save(true)}>
              {t("d.save")}
            </button>
          )}
          <button type="submit" className="pj-btn pj-btn-primary" disabled={busy || !name.trim()}>
            {t("c.save")}
          </button>
        </div>
        <p className="pj-small pj-muted">
          <Kbd>Enter</Kbd>
        </p>
      </form>
    </Modal>
  );
}

