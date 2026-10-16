"use client";

// Zvena Projects — the app at /projects, inside zvena's one frame (Shell):
// the rail is shared, Projects adds its block (ProjectsNav). Loads the
// workspace's bootstrap, switches screens by the URL, keeps other people's
// changes flowing in (a poll of the workspace's change counter), and owns
// its keys: C new issue, / Projects' command palette (⌘K is zvena's), ? help,
// G then a letter to go somewhere, and S/P/A/L/D/E/I on the open issue.

import "./projects.css";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Bootstrap } from "@/lib/projects/types";
import { Shell, type ShellSection } from "@/components/zvena/ds";
import type { SessionUser } from "@/lib/session";
import { openCreate, openPalette, typing, ui } from "./app-state";
import { api, boot, GOALS_EVENT, invalidateAll, loadBoot, online, setWorkspace, toast, useStore, type GoalReached } from "./data";
import { CommandPalette, ShortcutsHelp } from "./CommandPalette";
import { CreateIssueDialog } from "./CreateIssue";
import { InboxScreen } from "./Inbox";
import { IssueDetailView } from "./IssueDetail";
import { useT } from "./i18n";
import { PropPicker, useApply, type PropKind } from "./pickers";
import { CyclePage, CyclesList, ProjectPage, ProjectsList, Roadmap } from "./Planning";
import { copyIssueRefs, href, navigate, setParams, stay, syncLoc, useLoc } from "./router";
import { AllIssues, ArchiveScreen, MyIssues, SearchScreen, TeamIssues, ViewScreen, ViewsList } from "./Screens";
import { Onboarding, SettingsScreen } from "./Settings";
import { StaleDialog } from "./Assistant";
import { ProjectsNav } from "./ProjectsNav";
import { TriageScreen } from "./Triage";
import { InsightsScreen } from "./Insights";
import { ConfirmHost, Empty, ErrorState, LoadingRows, overlays, Popover, type Anchor } from "./ui";
import { localToday, markStale, useLookups } from "./data";

export function ProjectsApp({ user, initial, initialAt = 0 }: { user: SessionUser; initial?: Bootstrap | null; initialAt?: number }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  useState(() => {
    setWorkspace(user.ws.id);
    // Back from another section (a client navigation): the right screen, and what it
    // showed before at once while it is fetched again.
    syncLoc(pathname, search);
    stay();
    markStale();
  });
  const { data, error } = useStore(boot);
  const { t } = useT();
  // The page brought the bootstrap along: the app starts from it before the first
  // paint (no round trip); it is fetched again only when the browser's day is another
  // one or the page is a prefetched copy (the rail prefetches on hover, kept 30 s).
  useLayoutEffect(() => {
    if (initial && initial.ws.id === user.ws.id) {
      boot.set({ data: initial, error: null, loading: false });
      if (initial.today === localToday() && Date.now() - initialAt < 5_000) return;
    }
    void loadBoot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // "My issues" is the rail's My tasks; everything else is the Projects section.
  // From the router's address (it follows the app's own pushState too): the server
  // has no `location`, so the rail's current item now matches on hydration.
  const section: ShellSection = pathname.startsWith("/projects/my-issues") ? "my" : "projects";
  return (
    <Shell user={user} section={section} sectionNav={data ? <ProjectsNav /> : undefined} sectionTitle={t("app.name")} createHotkey={false} fill>
      {data ? (
        <Loaded />
      ) : (
        <div className="pj-app" data-shell="" data-loading="">
          <div className="pj-main">{error ? <ErrorState text={error.status === 403 ? t("c.forbidden") : undefined} onRetry={() => void loadBoot()} /> : <LoadingRows rows={10} />}</div>
        </div>
      )}
    </Shell>
  );
}

function Loaded() {
  const L = useLookups();
  const loc = useLoc();
  const state = useStore(ui);
  const isOnline = useStore(online);
  const { t } = useT();
  const apply = useApply();
  const [picker, setPicker] = useState<{ kind: PropKind; anchor: Anchor } | null>(null);
  const gPending = useRef(0);

  // Other people's changes: poll the change counter while the tab is visible.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const r = await api<{ seq: number; unread: number }>("changes");
        const b = boot.get().data;
        if (!alive || !b) return;
        if (r.seq !== b.seq) {
          await loadBoot();
          invalidateAll();
        } else if (r.unread !== b.unread) await loadBoot();
      } catch {
        // offline: the banner says so; the next tick retries
      }
    };
    const timer = setInterval(() => void tick(), 4000);
    const onVis = () => !document.hidden && void tick();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, []);

  // The person's own change met a goal: say so at once, with the way there.
  useEffect(() => {
    const on = (e: Event) => {
      for (const g of (e as CustomEvent<GoalReached[]>).detail ?? []) {
        const text = g.kind === "met" ? t("goal.metToast", { name: g.name }) : t("goal.msToast", { name: g.name });
        toast(text, "success", { label: t("goal.open"), run: () => navigate(`/project/${g.projectId}`) }, 8000);
      }
    };
    window.addEventListener(GOALS_EVENT, on);
    return () => window.removeEventListener(GOALS_EVENT, on);
  }, [t]);

  // Global keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (e.defaultPrevented || typing(e) || overlays.get().length || ui.get().create || ui.get().palette || ui.get().help) return;
      // The open issue page: ⌘. copies its identifier, ⌘⇧, its link (lists handle their own selection).
      const page = ui.get().target;
      if (mod && page.length && loc.path[0] === "issue" && (e.key === "." || (e.shiftKey && (e.key === "," || e.key === "<")))) {
        e.preventDefault();
        const what = e.key === "." ? "id" : "link";
        void copyIssueRefs(page, what).then((ok) => toast(ok ? (what === "id" ? t("k.copiedId", { ids: page.map((i) => i.identifier).join(", ") }) : t("k.copiedLink")) : t("c.copyFailed"), ok ? "success" : "error"));
        return;
      }
      if (mod || e.altKey) return;
      if (Date.now() - gPending.current < 1200) {
        gPending.current = 0;
        const firstTeam = L.b.teams.find((x) => x.isMember) ?? L.b.teams[0];
        const to: Record<string, string> = {
          i: "/inbox",
          m: "/my-issues",
          a: "/issues",
          p: "/projects",
          r: "/roadmap",
          v: "/views",
          s: "/settings",
          ...(firstTeam ? { c: `/team/${firstTeam.key}/cycles`, b: `/team/${firstTeam.key}/backlog`, t: `/team/${firstTeam.key}/issues` } : {}),
        };
        if (to[e.key]) {
          e.preventDefault();
          navigate(to[e.key]);
        }
        return;
      }
      if (e.key === "g") {
        gPending.current = Date.now();
        return;
      }
      if (e.key === "c" && L.canEdit) {
        e.preventDefault();
        const team = loc.path[0] === "team" ? L.teamByKey.get(loc.path[1]) : null;
        openCreate(team ? { teamId: team.id } : {});
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        openPalette();
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        ui.update((s) => ({ ...s, help: true }));
        return;
      }
      if (e.key === "Escape" && new URLSearchParams(location.search).get("peek")) {
        e.preventDefault();
        setParams({ peek: null });
        return;
      }
      // The open issue (its page): property shortcuts.
      const target = ui.get().target;
      if (!target.length || !L.canEdit) return;
      const kinds: Record<string, PropKind> = { s: "status", p: "priority", a: "assignee", l: "labels", d: "due", e: "estimate", P: "project", C: "cycle", M: "milestone" };
      if (kinds[e.key]) {
        e.preventDefault();
        setPicker({ kind: kinds[e.key], anchor: { x: window.innerWidth / 2 - 125, y: 140 } });
      } else if (e.key === "i") {
        e.preventDefault();
        void apply(target, { assigneeId: L.b.me.id });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [L, loc, apply, t]);

  // ?create=issue[&title=…][&for=<ref>] — "New issue" from anywhere in zvena opens the dialog here.
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    if (p.get("create") !== "issue") return;
    const forRef = p.get("for") ?? "";
    const project = /^project:([A-Za-z0-9_-]{1,40})$/.exec(forRef)?.[1];
    if (L.canEdit)
      openCreate({
        ...(p.get("title") ? { title: (p.get("title") as string).slice(0, 300) } : {}),
        ...(project && L.project.has(project) ? { projectId: project } : {}),
        ...(/^[a-z]+:[A-Za-z0-9_\/.-]{1,120}$/.test(forRef) ? { linkFor: forRef } : {}),
      });
    setParams({ create: null, title: null, for: null });
  }, [L]);

  const peek = loc.params.get("peek");
  const screen = route(loc.path);

  const noTeams = L.b.teams.length === 0;
  return (
    <div className="pj-app" data-shell="">
      <div className="pj-main" key={loc.path.join("/")}>
        {!isOnline && <div className="pj-offline">{t("c.offline")}</div>}
        {noTeams && !["settings"].includes(loc.path[0] ?? "") ? <Onboarding /> : screen}
      </div>
      {peek && loc.path[0] !== "issue" && (
        <aside className="pj-peek" aria-label={peek}>
          <IssueDetailView key={peek} issueRef={peek} mode="peek" />
        </aside>
      )}
      {state.create && <CreateIssueDialog defaults={state.create} />}
      {state.palette && <CommandPalette />}
      {state.help && <ShortcutsHelp />}
      {state.stale && <StaleDialog onClose={() => ui.update((s) => ({ ...s, stale: false }))} onFilter={(f) => navigate(`/issues?due=${f.due ?? ""}`)} />}
      {picker && state.target.length > 0 && (
        <Popover anchor={picker.anchor} onClose={() => setPicker(null)} width={picker.kind === "due" ? 268 : 250} label={picker.kind}>
          <PropPicker kind={picker.kind} issues={state.target} onClose={() => setPicker(null)} />
        </Popover>
      )}
      <ConfirmHost />
    </div>
  );
}

function route(path: string[]) {
  const [a, b, c, d] = path;
  switch (a) {
    case undefined:
      return <Redirect to="/my-issues" />;
    case "inbox":
      return <InboxScreen />;
    case "my-issues":
      return <MyIssues tab={b} />;
    case "issues":
      return <AllIssues tab={b} />;
    case "archive":
      return <ArchiveScreen />;
    case "team":
      if (!b) return <Redirect to="/issues" />;
      if (c === "cycles" && d) return <CyclePage teamKey={b} number={d} />;
      if (c === "cycles") return <CyclesList teamKey={b} />;
      if (c === "projects") return <ProjectsList teamKey={b} />;
      if (c === "settings") return <SettingsScreen teamKey={b} />;
      if (c === "triage") return <TriageScreen teamKey={b} />;
      return <TeamIssues teamKey={b} tab={c ?? "issues"} />;
    case "projects":
      return <ProjectsList />;
    case "project":
      return b ? <ProjectPage id={b} tab={c} /> : <Redirect to="/projects" />;
    case "roadmap":
      return <Roadmap />;
    case "insights":
      return <InsightsScreen />;
    case "views":
      return <ViewsList />;
    case "view":
      return b ? <ViewScreen id={b} /> : <Redirect to="/views" />;
    case "issue":
      return b ? <IssuePage issueRef={b} /> : <Redirect to="/issues" />;
    case "search":
      return <SearchScreen />;
    case "settings":
      if (b === "team" && c) return <SettingsScreen teamKey={c} />;
      return <SettingsScreen tab={b} />;
    default:
      return <NotFound />;
  }
}

function IssuePage({ issueRef }: { issueRef: string }) {
  return (
    <div className="pj-screen pj-issue-page">
      <IssueDetailView key={issueRef} issueRef={issueRef} mode="page" />
    </div>
  );
}

/** Goes to another screen, keeping the URL's parameters (?create=issue survives /projects → /my-issues). */
function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(href(to, new URLSearchParams(location.search)), { replace: true }), [to]);
  return null;
}

function NotFound() {
  const { t } = useT();
  return <Empty title={t("i.notFound")} />;
}
