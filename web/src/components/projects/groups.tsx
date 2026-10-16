"use client";

// What an issue group is in the interface: its title, icon and order, the
// properties a new issue created in it gets, and the change that moving an
// issue into it makes (a board drop into "In Review", "High", "Anna"…).
// Status groups merge statuses of the same name across teams.

import type { ReactNode } from "react";
import { Box, RefreshCcw, Users } from "lucide-react";
import { CATEGORY_RANK, type Grouping, type Issue, type Priority, type StatusCategory } from "@/lib/projects/types";
import type { Lookups } from "./data";
import { CycleGlyph, Glyph, PriorityIcon, ProjectGlyph, StatusIcon } from "./icons";
import type { PT } from "./i18n";
import { Avatar, UnassignedIcon } from "./ui";

export interface GroupInfo {
  key: string;
  label: string;
  icon: ReactNode;
  color?: string;
  order: number[];
  /** Board order (the workflow: backlog → … → done), when it differs from the list's. */
  flow?: number[];
  /** Properties of an issue created from this group's "+". */
  create: (teamId: string) => Record<string, unknown>;
  /** The change that moves `issue` into this group (null: not possible). */
  move: (issue: Issue) => Record<string, unknown> | null;
}

export function groupInfo(L: Lookups, g: Grouping, key: string, t: PT): GroupInfo {
  switch (g) {
    case "status": {
      const [category, ...rest] = key.split(":");
      const name = rest.join(":");
      const all = L.b.statuses.filter((s) => s.category === category && s.name === name);
      const s = all[0];
      const statusFor = (teamId: string) => all.find((x) => x.teamId === teamId)?.id ?? L.statusesOf(teamId).find((x) => x.category === category)?.id ?? null;
      return {
        key,
        label: name,
        color: s?.color,
        icon: <StatusIcon category={category as StatusCategory} color={s?.color ?? "#95a2b3"} fraction={s ? L.fraction(s.id) : 0.5} />,
        order: [CATEGORY_RANK[category as StatusCategory] ?? 9, s?.position ?? 0],
        flow: [FLOW_RANK[category as StatusCategory] ?? 9, s?.position ?? 0],
        create: (teamId) => {
          const id = statusFor(teamId);
          return id ? { statusId: id } : {};
        },
        move: (issue) => {
          const id = statusFor(issue.teamId);
          return id && id !== issue.statusId ? { statusId: id } : id ? {} : null;
        },
      };
    }
    case "assignee": {
      const p = key ? L.person.get(key) : null;
      return {
        key,
        label: key ? (p?.name ?? t("act.former")) : t("f.noAssignee"),
        icon: key ? <Avatar name={p?.name ?? "?"} id={key} size={18} src={p?.avatar} /> : <UnassignedIcon size={18} />,
        order: [key === L.b.me.id ? 0 : key ? 1 : 2, 0],
        create: () => ({ assigneeId: key || null }),
        move: () => ({ assigneeId: key || null }),
      };
    }
    case "priority": {
      const p = Number(key) as Priority;
      return {
        key,
        label: t(`prio.${p}`),
        icon: <PriorityIcon priority={p} />,
        order: [p === 0 ? 5 : p, 0],
        create: () => ({ priority: p }),
        move: () => ({ priority: p }),
      };
    }
    case "project": {
      const p = key ? L.project.get(key) : null;
      return {
        key,
        label: key ? (p?.name ?? "—") : t("f.noProject"),
        icon: p ? <ProjectGlyph icon={p.icon} color={p.color} /> : <Box size={15} className="pj-muted-icon" />,
        order: [key ? 0 : 1, p?.sortOrder ?? 0],
        create: () => ({ projectId: key || null }),
        move: () => ({ projectId: key || null }),
      };
    }
    case "cycle": {
      const c = key ? L.cycle.get(key) : null;
      return {
        key,
        label: c ? `${L.team.get(c.teamId)?.key ?? ""} · ${c.name || t("cy.name", { n: c.number })}` : t("f.noCycle"),
        icon: c ? <CycleGlyph progress={c.progress.total ? c.progress.completed / c.progress.total : 0} /> : <RefreshCcw size={14} className="pj-muted-icon" />,
        order: [c ? 0 : 1, c ? -Date.parse(c.startsOn) : 0],
        create: (teamId) => (c && c.teamId === teamId ? { cycleId: key } : {}),
        move: (issue) => (c ? (c.teamId === issue.teamId && !c.completedAt ? { cycleId: key } : null) : { cycleId: null }),
      };
    }
    case "team": {
      const tm = L.team.get(key);
      return {
        key,
        label: tm?.name ?? "—",
        icon: tm ? <Glyph icon={tm.icon} color={tm.color} text={tm.name} size={16} /> : <Users size={15} />,
        order: [0, 0],
        create: () => ({ teamId: key }),
        move: (issue) => (issue.teamId === key ? {} : { teamId: key }),
      };
    }
    default:
      return { key, label: "", icon: null, order: [0, 0], create: () => ({}), move: () => ({}) };
  }
}

const FLOW_RANK: Record<StatusCategory, number> = { backlog: 0, unstarted: 1, started: 2, completed: 3, canceled: 4 };

/** Lists show active work first; boards follow the workflow left to right. */
export function sortGroups(infos: GroupInfo[], board = false): GroupInfo[] {
  const key = (g: GroupInfo) => (board && g.flow ? g.flow : g.order);
  return [...infos].sort((a, b) => key(a)[0] - key(b)[0] || key(a)[1] - key(b)[1] || a.label.localeCompare(b.label));
}

/** Every group that could exist (for "show empty groups" and board columns). */
export function allGroupKeys(L: Lookups, g: Grouping, teamIds: string[]): string[] {
  switch (g) {
    case "status": {
      const keys = new Set<string>();
      for (const s of L.b.statuses) if (teamIds.includes(s.teamId)) keys.add(`${s.category}:${s.name}`);
      return [...keys];
    }
    case "assignee":
      return ["", ...L.b.people.filter((p) => p.role).map((p) => p.id)];
    case "priority":
      return ["1", "2", "3", "4", "0"];
    case "project":
      return ["", ...L.b.projects.filter((p) => !p.archivedAt).map((p) => p.id)];
    case "cycle":
      return ["", ...L.b.cycles.filter((c) => teamIds.includes(c.teamId) && !c.completedAt).map((c) => c.id)];
    case "team":
      return teamIds;
    default:
      return ["all"];
  }
}
