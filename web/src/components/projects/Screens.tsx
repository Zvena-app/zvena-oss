"use client";

// The issue-list screens (My issues, All issues, team issues and backlog,
// the archive, saved views), the list of views and the search page.

import { useEffect, useState, type ReactNode } from "react";
import { Archive, CircleUser, Layers, ListTodo, Search, Star, Trash2 } from "lucide-react";
import type { IssueFilter, SavedView } from "@/lib/projects/types";
import { api, errorText, loadBoot, toast, toggleFavorite, useLookups, useQuery } from "./data";
import { Glyph, ProjectGlyph, StatusIcon, uiColor } from "./icons";
import { useT } from "./i18n";
import { IssuesScreen } from "./IssuesScreen";
import { href, Link, navigate, setParams, useLoc } from "./router";
import { Avatar, confirmDialog, Empty, IconButton, LoadingRows } from "./ui";

export function Tabs({ items }: { items: { to: string; label: string; active: boolean }[] }) {
  const { t } = useT();
  return (
    <nav className="pj-tabs" aria-label={t("a11y.tabs")}>
      {items.map((i) => (
        <Link key={i.to} to={i.to} className="pj-tab" aria-current={i.active ? "page" : undefined}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

export function MyIssues({ tab }: { tab?: string }) {
  const { t } = useT();
  const L = useLookups();
  const cur = tab === "created" || tab === "subscribed" ? tab : "assigned";
  const base: IssueFilter = cur === "assigned" ? { assignee: ["me"] } : cur === "created" ? { creator: ["me"] } : { subscribed: true };
  return (
    <IssuesScreen
      key={cur}
      title={t("nav.myIssues")}
      icon={<CircleUser size={16} />}
      base={base}
      hide={cur === "assigned" ? ["assignee"] : cur === "created" ? ["creator"] : []}
      memoryKey={`my-${cur}`}
      defaults={{ group: "status" }}
      create={cur === "assigned" ? { assigneeId: L.b.me.id } : undefined}
      tabs={
        <Tabs
          items={[
            { to: "/my-issues", label: t("my.assigned"), active: cur === "assigned" },
            { to: "/my-issues/created", label: t("my.created"), active: cur === "created" },
            { to: "/my-issues/subscribed", label: t("my.subscribed"), active: cur === "subscribed" },
          ]}
        />
      }
    />
  );
}

export function AllIssues({ tab }: { tab?: string }) {
  const { t } = useT();
  const cur = tab === "active" || tab === "backlog" ? tab : "all";
  const base: IssueFilter | undefined = cur === "active" ? { category: ["unstarted", "started"] } : cur === "backlog" ? { category: ["backlog"] } : undefined;
  return (
    <IssuesScreen
      key={cur}
      title={t("nav.allIssues")}
      icon={<ListTodo size={16} />}
      base={base}
      hide={cur === "all" ? [] : ["category"]}
      memoryKey={`all-${cur}`}
      tabs={
        <Tabs
          items={[
            { to: "/issues", label: t("pr.all"), active: cur === "all" },
            { to: "/issues/active", label: t("nav.active"), active: cur === "active" },
            { to: "/issues/backlog", label: t("nav.backlog"), active: cur === "backlog" },
          ]}
        />
      }
    />
  );
}

export function TeamIssues({ teamKey, tab }: { teamKey: string; tab: string }) {
  const { t } = useT();
  const L = useLookups();
  const team = L.teamByKey.get(teamKey);
  if (!team) return <Empty title={t("i.notFound")} />;
  const cur = tab === "active" || tab === "backlog" ? tab : "issues";
  const base: IssueFilter | undefined = cur === "active" ? { category: ["unstarted", "started"] } : cur === "backlog" ? { category: ["backlog"] } : undefined;
  const backlogStatus = L.statusesOf(team.id).find((s) => s.category === "backlog");
  return (
    <IssuesScreen
      key={`${team.id}-${cur}`}
      title={team.name}
      icon={<Glyph icon={team.icon} color={team.color} text={team.name} size={18} />}
      scope={{ teamId: team.id }}
      base={base}
      hide={cur === "issues" ? ["team"] : ["team", "category"]}
      memoryKey={`team-${team.id}-${cur}`}
      defaults={cur === "backlog" ? { group: "none", order: "priority" } : { layout: "list" }}
      create={{ teamId: team.id, ...(cur === "backlog" && backlogStatus ? { statusId: backlogStatus.id } : {}) }}
      headerExtra={
        <IconButton label={L.isFavorite("team", team.id) ? t("c.unfavorite") : t("c.favorite")} onClick={() => void toggleFavorite("team", team.id, !L.isFavorite("team", team.id))} active={L.isFavorite("team", team.id)}>
          <Star size={15} fill={L.isFavorite("team", team.id) ? "currentColor" : "none"} />
        </IconButton>
      }
      tabs={
        <Tabs
          items={[
            { to: `/team/${team.key}/issues`, label: t("pr.all"), active: cur === "issues" },
            { to: `/team/${team.key}/active`, label: t("nav.active"), active: cur === "active" },
            { to: `/team/${team.key}/backlog`, label: t("nav.backlog"), active: cur === "backlog" },
          ]}
        />
      }
    />
  );
}

export function ArchiveScreen() {
  const { t } = useT();
  return <IssuesScreen title={t("nav.archive")} icon={<Archive size={16} />} base={{ archived: true }} hide={["flags"]} memoryKey="archive" defaults={{ group: "none", order: "updated" }} />;
}

export function ViewScreen({ id }: { id: string }) {
  const { t } = useT();
  const L = useLookups();
  const v = L.view.get(id);
  if (!v) return <Empty title={t("v.notFound")} />;
  const canSave = v.ownerId === L.b.me.id || (v.shared && L.canEdit);
  return (
    <IssuesScreen
      key={v.id}
      title={v.name}
      icon={<Layers size={16} style={{ color: v.color }} />}
      scope={{ teamId: v.teamId ?? undefined, projectId: v.projectId ?? undefined }}
      memoryKey={`view-${v.id}`}
      view={{ id: v.id, name: v.name, canSave, filters: v.filters, display: v.display }}
      headerExtra={
        <IconButton label={L.isFavorite("view", v.id) ? t("c.unfavorite") : t("c.favorite")} onClick={() => void toggleFavorite("view", v.id, !L.isFavorite("view", v.id))} active={L.isFavorite("view", v.id)}>
          <Star size={15} fill={L.isFavorite("view", v.id) ? "currentColor" : "none"} />
        </IconButton>
      }
    />
  );
}

export function ViewsList() {
  const { t } = useT();
  const L = useLookups();
  const views = L.b.views;
  const del = async (v: SavedView) => {
    if (!(await confirmDialog({ title: t("v.deleteConfirm", { name: v.name }), ok: t("c.delete"), danger: true }))) return;
    try {
      await api(`views/${v.id}`, { method: "DELETE" });
      await loadBoot();
    } catch (e) {
      toast(errorText(e, t), "error");
    }
  };
  return (
    <div className="pj-screen">
      <header className="pj-head">
        <div className="pj-head-title">
          <Layers size={16} />
          <h1>{t("v.title")}</h1>
        </div>
      </header>
      <div className="pj-screen-body pj-pad">
        {views.length === 0 ? (
          <Empty icon={<Layers size={22} />} title={t("v.empty")} hint={t("v.emptyHint")} starts={[{ id: "issues", label: t("nav.allIssues"), icon: <ListTodo size={16} />, tint: "var(--ui-tint-orange)", onClick: () => navigate("/issues") }]} />
        ) : (
          <div className="pj-table" role="table">
            {views.map((v) => {
              const owner = L.person.get(v.ownerId);
              return (
                <div key={v.id} className="pj-table-row" role="row">
                  <Layers size={15} style={{ color: v.color }} />
                  <Link to={`/view/${v.id}`} className="pj-table-main">
                    {v.name}
                  </Link>
                  <span className="pj-tag">{v.shared ? t("v.shared") : t("v.personal")}</span>
                  {owner && <Avatar name={owner.name} id={owner.id} size={18} />}
                  {(v.ownerId === L.b.me.id || L.isOwner) && (
                    <IconButton label={t("c.delete")} onClick={() => void del(v)}>
                      <Trash2 size={14} />
                    </IconButton>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

interface SearchRes {
  issues: { id: string; identifier: string; title: string; statusId: string; teamId: string; snippet: string }[];
  projects: { id: string; name: string; color: string; icon: string | null }[];
  teams: { id: string; key: string; name: string }[];
  labels: { id: string; name: string; color: string }[];
}

export function SearchScreen() {
  const { t } = useT();
  const L = useLookups();
  const loc = useLoc();
  const q = loc.params.get("q") ?? "";
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (text !== q) setParams({ q: text || null });
    }, 250);
    return () => clearTimeout(timer);
  }, [text, q]);
  const { data, loading } = useQuery<SearchRes>(q ? `search:${q}` : null, () => api<SearchRes>("search", { query: { q } }));
  const section = (title: string, children: ReactNode) => (
    <section className="pj-search-sec">
      <h2>{title}</h2>
      {children}
    </section>
  );
  const total = data ? data.issues.length + data.projects.length + data.teams.length + data.labels.length : 0;
  return (
    <div className="pj-screen">
      <header className="pj-head">
        <div className="pj-search-box">
          <Search size={16} />
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={t("s.placeholder")} aria-label={t("nav.search")} />
        </div>
      </header>
      <div className="pj-screen-body pj-pad">
        {!q ? (
          <Empty icon={<Search size={22} />} title={t("nav.search")} hint={t("s.hint")} />
        ) : loading || !data ? (
          <LoadingRows />
        ) : total === 0 ? (
          <Empty title={t("s.nothing")} />
        ) : (
          <>
            {data.issues.length > 0 &&
              section(
                t("s.issues"),
                data.issues.map((i) => {
                  const s = L.status.get(i.statusId);
                  return (
                    <Link key={i.id} to={`/issue/${i.identifier}`} className="pj-search-hit">
                      {s && <StatusIcon category={s.category} color={s.color} fraction={L.fraction(s.id)} />}
                      <span className="pj-row-id">{i.identifier}</span>
                      <span className="pj-search-title">{i.title}</span>
                      {i.snippet && <span className="pj-search-snippet">{i.snippet}</span>}
                    </Link>
                  );
                })
              )}
            {data.projects.length > 0 &&
              section(
                t("s.projects"),
                data.projects.map((p) => (
                  <Link key={p.id} to={`/project/${p.id}`} className="pj-search-hit">
                    <ProjectGlyph icon={p.icon} color={p.color} />
                    <span className="pj-search-title">{p.name}</span>
                  </Link>
                ))
              )}
            {data.teams.length > 0 &&
              section(
                t("s.teams"),
                data.teams.map((x) => {
                  const tm = L.team.get(x.id);
                  return (
                    <Link key={x.id} to={`/team/${x.key}/issues`} className="pj-search-hit">
                      {tm && <Glyph icon={tm.icon} color={tm.color} text={tm.name} size={16} />}
                      <span className="pj-search-title">{x.name}</span>
                      <span className="pj-row-id">{x.key}</span>
                    </Link>
                  );
                })
              )}
            {data.labels.length > 0 &&
              section(
                t("s.labels"),
                data.labels.map((l) => (
                  <a
                    key={l.id}
                    href={href("/issues", { label: l.id })}
                    className="pj-search-hit"
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(href("/issues", { label: l.id }));
                    }}
                  >
                    <span className="pj-dot" style={{ background: uiColor(l.color) }} />
                    <span className="pj-search-title">{l.name}</span>
                  </a>
                ))
              )}
          </>
        )}
      </div>
    </div>
  );
}
