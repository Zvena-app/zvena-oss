"use client";

// Projects' own block in zvena's one rail (design system: Shell). The Shell
// already has the workspace, + Create, Search ⌘K, Home, Inbox, My tasks and
// the sections; Projects adds only its views, favorites and teams here.

import type { MouseEvent } from "react";
import { Archive, Box, ChartColumnBig, Clock, Copy, Inbox as InboxIcon, Layers, ListTodo, Map as MapIcon, Plus, RefreshCcw, Settings, Star } from "lucide-react";
import { ShellNavItem, ShellNavList } from "@/components/zvena/ds";
import { ui } from "./app-state";
import { useLookups } from "./data";
import { CycleGlyph, Glyph, ProjectGlyph, uiColor } from "./icons";
import { useT } from "./i18n";
import { href, navigate, useLoc } from "./router";

/** A rail item that switches screens inside Projects without a page load. */
function Item({ to, label, icon, dot, active, indent, badge }: { to: string; label: string; icon?: React.ReactNode; dot?: string; active?: boolean; indent?: boolean; badge?: number }) {
  return (
    <ShellNavItem
      href={href(to)}
      label={label}
      icon={icon}
      dot={dot}
      active={active}
      indent={indent}
      badge={badge}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}

export function ProjectsNav() {
  const { t } = useT();
  const L = useLookups();
  const loc = useLoc();
  const path = loc.path;
  const at = (...p: string[]) => p.every((x, i) => path[i] === x) && path.length >= p.length;
  const myTeams = L.b.teams.filter((x) => x.isMember && !x.archivedAt);
  const otherTeams = L.b.teams.filter((x) => !x.isMember && !x.archivedAt);
  const openTeam = path[0] === "team" ? path[1] : null;
  return (
    <>
      <ShellNavList label={t("app.name")}>
        <Item to="/issues" label={t("nav.allIssues")} icon={<ListTodo />} active={at("issues")} />
        <Item to="/projects" label={t("nav.projects")} icon={<Box />} active={at("projects") || at("project")} />
        <Item to="/roadmap" label={t("nav.roadmap")} icon={<MapIcon />} active={at("roadmap")} />
        <Item to="/insights" label={t("nav.insights")} icon={<ChartColumnBig />} active={at("insights")} />
        <Item to="/views" label={t("nav.views")} icon={<Layers />} active={at("views") || at("view")} />
        <ShellNavItem
          href="#"
          label={t("as.stale")}
          icon={<Clock />}
          onClick={(e) => {
            e.preventDefault();
            ui.update((s) => ({ ...s, stale: true }));
          }}
        />
        <Item to="/archive" label={t("nav.archive")} icon={<Archive />} active={at("archive")} />
      </ShellNavList>

      {L.b.favorites.length > 0 && (
        <>
          <div className="ds-nav-title">{t("nav.favorites")}</div>
          <ShellNavList label={t("nav.favorites")}>
            {L.b.favorites.map((f) => {
              if (f.kind === "project") {
                const p = L.project.get(f.targetId);
                return p ? <Item key={f.targetId} to={`/project/${p.id}`} label={p.name} icon={<ProjectGlyph icon={p.icon} color={p.color} />} active={at("project", p.id)} /> : null;
              }
              if (f.kind === "view") {
                const v = L.view.get(f.targetId);
                return v ? <Item key={f.targetId} to={`/view/${v.id}`} label={v.name} dot={uiColor(v.color)} active={at("view", v.id)} /> : null;
              }
              if (f.kind === "cycle") {
                const c = L.cycle.get(f.targetId);
                const tm = c ? L.team.get(c.teamId) : null;
                return c && tm ? <Item key={f.targetId} to={`/team/${tm.key}/cycles/${c.number}`} label={`${tm.key} · ${c.name || t("cy.name", { n: c.number })}`} icon={<CycleGlyph />} /> : null;
              }
              if (f.kind === "team") {
                const tm = L.team.get(f.targetId);
                return tm ? <Item key={f.targetId} to={`/team/${tm.key}/issues`} label={tm.name} icon={<Glyph icon={tm.icon} color={tm.color} text={tm.name} size={16} />} /> : null;
              }
              if (f.kind === "issue" && f.identifier) return <Item key={f.targetId} to={`/issue/${f.identifier}`} label={`${f.identifier} ${f.title ?? ""}`} icon={<Star />} active={at("issue", f.identifier)} />;
              return null;
            })}
          </ShellNavList>
        </>
      )}

      <div className="ds-nav-title">
        <span>{t("nav.teams")}</span>
        {L.canEdit && (
          <a
            href={href("/settings/teams?new=1")}
            className="pj-rail-action"
            aria-label={t("nav.newTeam")}
            title={t("nav.newTeam")}
            onClick={(e) => {
              e.preventDefault();
              navigate("/settings/teams?new=1");
            }}
          >
            <Plus size={13} />
          </a>
        )}
      </div>
      <ShellNavList label={t("nav.teams")}>
        {myTeams.map((tm) => {
          const open = openTeam === tm.key || myTeams.length === 1;
          const cur = L.currentCycle(tm.id);
          return (
            <div key={tm.id}>
              <Item to={`/team/${tm.key}/issues`} label={tm.name} icon={<Glyph icon={tm.icon} color={tm.color} text={tm.name} size={16} />} active={at("team", tm.key, "issues") || at("team", tm.key, "active")} />
              {open && (
                <>
                  {tm.triage && (
                    <Item to={`/team/${tm.key}/triage`} label={t("nav.triage")} icon={<InboxIcon />} indent active={at("team", tm.key, "triage")} badge={tm.triageCount || undefined} />
                  )}
                  <Item to={`/team/${tm.key}/backlog`} label={t("nav.backlog")} icon={<Copy />} indent active={at("team", tm.key, "backlog")} />
                  {tm.cyclesEnabled && (
                    <Item to={`/team/${tm.key}/cycles`} label={cur ? `${t("nav.cycles")} · ${cur.name || `#${cur.number}`}` : t("nav.cycles")} icon={<RefreshCcw />} indent active={at("team", tm.key, "cycles")} />
                  )}
                  <Item to={`/team/${tm.key}/projects`} label={t("nav.projects")} icon={<Box />} indent active={at("team", tm.key, "projects")} />
                  <Item to={`/settings/team/${tm.key}`} label={t("nav.settings")} icon={<Settings />} indent active={at("settings", "team", tm.key)} />
                </>
              )}
            </div>
          );
        })}
        {otherTeams.map((tm) => (
          <Item key={tm.id} to={`/team/${tm.key}/issues`} label={tm.name} icon={<Glyph icon={tm.icon} color={tm.color} text={tm.name} size={16} />} active={at("team", tm.key)} />
        ))}
        <Item to="/settings" label={t("st.title")} icon={<Settings />} active={at("settings") && path[1] !== "team"} />
      </ShellNavList>
    </>
  );
}
