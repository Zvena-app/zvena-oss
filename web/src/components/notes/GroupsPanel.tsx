"use client";

// Settings → Groups (Notion: Members → Groups): groups of the workspace's
// members. The workspace owner creates, renames and deletes them and picks
// their members; pages and teamspaces are then shared with a group as a
// whole. Others see the groups (they can share with them). The server checks
// everything again (/api/notes/groups).

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Users, X } from "lucide-react";
import { useNotes } from "./context";
import { Menu, Popover, toast } from "./ui";
import { withWs } from "@/lib/notes/workspace";
import { initials, people } from "@/lib/notes/people";

interface GroupFull {
  id: string;
  name: string;
  members: string[];
}

interface GroupsInfo {
  groups: { id: string; name: string; members: number }[];
  list?: GroupFull[];
}

export function useGroups(enabled = true): { groups: GroupsInfo["groups"]; list: GroupFull[] | null; reload: () => void } {
  const [info, setInfo] = useState<GroupsInfo | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((x) => x + 1), []);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void fetch(withWs("/api/notes/groups"), { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<GroupsInfo>) : null))
      .then((j) => live && j && setInfo(j))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [enabled, tick]);
  return { groups: info?.groups ?? [], list: info?.list ?? null, reload };
}

async function post(body: Record<string, unknown>): Promise<boolean> {
  try {
    const r = await fetch(withWs("/api/notes/groups"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return r.ok;
  } catch {
    return false;
  }
}

export function GroupsPanel() {
  const { t, user } = useNotes();
  const owner = user?.ws.role === "owner";
  const { groups, list, reload } = useGroups(true);
  const [name, setName] = useState("");
  const [adding, setAdding] = useState<{ id: string; el: HTMLElement } | null>(null);
  const byId = useMemo(() => new Map(people().map((p) => [p.id, p])), []);
  const act = async (body: Record<string, unknown>) => {
    if (await post(body)) reload();
    else toast(t("groups.failed"));
  };
  return (
    <div className="nt-groups">
      <p className="nt-settings-hint">{t("groups.hint")}</p>
      {owner && (
        <form
          className="nt-groups-new"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            void act({ op: "create", name: name.trim() });
            setName("");
          }}
        >
          <input className="nt-input" value={name} placeholder={t("groups.namePlaceholder")} onChange={(e) => setName(e.target.value)} maxLength={100} />
          <button type="submit" className="nt-btn nt-btn-primary nt-btn-sm nt-btn-reset" disabled={!name.trim()}>
            <Plus size={14} />
            {t("groups.create")}
          </button>
        </form>
      )}
      {groups.length === 0 && <p className="nt-settings-hint">{t("groups.none")}</p>}
      {(list ?? groups.map((g) => ({ id: g.id, name: g.name, members: [] as string[] }))).map((g) => {
        const count = list ? g.members.length : (groups.find((x) => x.id === g.id)?.members ?? 0);
        return (
          <div key={g.id} className="nt-groups-item">
            <div className="nt-groups-head">
              <span className="nt-share-general-icon">
                <Users size={16} />
              </span>
              <span className="nt-share-person-name">
                {g.name}
                <small>{t("groups.members", { n: count })}</small>
              </span>
              {owner && (
                <>
                  <button type="button" className="nt-btn nt-btn-plain nt-btn-sm nt-btn-reset" onClick={(e) => setAdding({ id: g.id, el: e.currentTarget })}>
                    {t("groups.addMembers")}
                  </button>
                  <button
                    type="button"
                    className="nt-icon-btn nt-btn-reset"
                    aria-label={t("groups.delete")}
                    title={t("groups.delete")}
                    onClick={() => {
                      if (window.confirm(t("groups.deleteConfirm", { name: g.name }))) void act({ op: "delete", id: g.id });
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </div>
            {list && g.members.length > 0 && (
              <div className="nt-share-people" role="list">
                {g.members.map((m) => {
                  const p = byId.get(m);
                  return (
                    <div key={m} className="nt-share-person" role="listitem">
                      <span className="nt-cm-avatar">{initials(p?.name || "?")}</span>
                      <span className="nt-share-person-name">{p?.name || t("people.unknown")}</span>
                      {owner && (
                        <button type="button" className="nt-icon-btn nt-btn-reset" aria-label={t("groups.removeMember")} title={t("groups.removeMember")} onClick={() => void act({ op: "remove", id: g.id, userId: m })}>
                          <X size={14} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      {adding && list && (
        <Popover anchor={adding.el} onClose={() => setAdding(null)} placement="bottom-end">
          <Menu
            width={280}
            onClose={() => setAdding(null)}
            groups={[
              {
                key: "people",
                items: people()
                  .filter((p) => p.role && !(list.find((g) => g.id === adding.id)?.members ?? []).includes(p.id))
                  .map((p) => ({
                    key: p.id,
                    label: p.name,
                    icon: <span className="nt-cm-avatar">{initials(p.name)}</span>,
                    onSelect: () => {
                      void act({ op: "add", id: adding.id, userId: p.id });
                      setAdding(null);
                    },
                  })),
              },
            ]}
          />
        </Popover>
      )}
    </div>
  );
}
