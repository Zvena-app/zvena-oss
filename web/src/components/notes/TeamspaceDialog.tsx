"use client";

// Teamspaces (Notion): "Create teamspace" and "Teamspace settings" — name,
// permissions (open / closed / private) and members — plus "Browse
// teamspaces" to join an open one. The server checks every change
// (api/notes/teamspaces).

import { useCallback, useEffect, useState } from "react";
import { Globe, Lock, Users, X } from "lucide-react";
import { useNotes, type NotesTeamspace } from "./context";
import { Menu, Modal, Popover, toast } from "./ui";
import { useGroups } from "./GroupsPanel";
import { initials, people } from "@/lib/notes/people";
import type { NotesKey } from "@/lib/notes/i18n";

type Privacy = NotesTeamspace["privacy"];

const PRIVACY: { key: Privacy; title: NotesKey; hint: NotesKey; icon: React.ReactNode }[] = [
  { key: "open", title: "ts.open", hint: "ts.openHint", icon: <Globe size={16} /> },
  { key: "closed", title: "ts.closed", hint: "ts.closedHint", icon: <Users size={16} /> },
  { key: "private", title: "ts.private", hint: "ts.privateHint", icon: <Lock size={16} /> },
];

async function call(ws: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`/api/notes/teamspaces?ws=${encodeURIComponent(ws)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return r.ok ? j : { error: j.error ?? "failed" };
  } catch {
    return null;
  }
}

/** `ts` absent: create one. */
export function TeamspaceDialog({ ts, onClose }: { ts?: NotesTeamspace; onClose: () => void }) {
  const api = useNotes();
  const { t, user } = api;
  const ws = user?.ws.id ?? "";
  const [name, setName] = useState(ts?.name ?? "");
  const [privacy, setPrivacy] = useState<Privacy>(ts?.privacy ?? "open");
  const [members, setMembers] = useState<{ userId: string; name: string; role: "owner" | "member" }[] | null>(null);
  const [tsGroups, setTsGroups] = useState<{ groupId: string; name: string }[]>([]);
  const [canManage, setCanManage] = useState(!ts);
  const [add, setAdd] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const loadMembers = useCallback(() => setTick((x) => x + 1), []);
  const tsId = ts?.id;
  useEffect(() => {
    if (!tsId) return;
    let live = true;
    void fetch(`/api/notes/teamspaces?ws=${encodeURIComponent(ws)}&id=${encodeURIComponent(tsId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ members: { userId: string; name: string; role: "owner" | "member" }[]; groups?: { groupId: string; name: string }[]; canManage: boolean }>) : null))
      .then((j) => {
        if (!live || !j) return;
        setMembers(j.members);
        setTsGroups(j.groups ?? []);
        setCanManage(j.canManage);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [tsId, ws, tick]);
  const run = async (body: Record<string, unknown>, after?: () => void) => {
    setBusy(true);
    const r = await call(ws, body);
    setBusy(false);
    if (!r || r.error) {
      toast(r?.error === "not empty" ? t("ts.notEmpty") : t("ts.failed"));
      return false;
    }
    api.reloadTeamspaces();
    // Pages of the teamspace come back (or go) with the new access.
    api.syncNow();
    after?.();
    return true;
  };
  const save = (patch: Record<string, unknown>) => (ts ? void run({ op: "update", id: ts.id, ...patch }) : undefined);
  const candidates = people().filter((p) => p.role && !(members ?? []).some((m) => m.userId === p.id));
  // Groups can be members as a whole (their members get the teamspace).
  const { groups: allGroups } = useGroups(Boolean(ts && canManage));
  const groupCandidates = allGroups.filter((g) => !tsGroups.some((x) => x.groupId === g.id));
  return (
    <Modal onClose={onClose} label={ts ? t("ts.settings") : t("ts.create")} className="nt-ts-dialog">
      <div style={{ padding: "18px 20px 0", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{ts ? t("ts.settings") : t("ts.create")}</div>
        <button type="button" className="nt-icon-btn nt-btn-reset" aria-label={t("common.close")} onClick={onClose}>
          <X />
        </button>
      </div>
      <div style={{ padding: "14px 20px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
        <input
          className="nt-input"
          autoFocus={!ts}
          value={name}
          disabled={!canManage}
          placeholder={t("ts.namePlaceholder")}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => ts && name.trim() && name.trim() !== ts.name && save({ name: name.trim() })}
          onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
        />
        <div>
          <div className="nt-menu-label">{t("ts.privacy")}</div>
          {PRIVACY.map((p) => (
            <button
              key={p.key}
              type="button"
              className="nt-mi nt-btn-reset"
              role="menuitemradio"
              aria-checked={privacy === p.key}
              disabled={!canManage || busy}
              onClick={() => {
                setPrivacy(p.key);
                if (ts && p.key !== ts.privacy) save({ privacy: p.key });
              }}
            >
              <span className="nt-mi-icon">{p.icon}</span>
              <span className="nt-mi-label">
                <span className="nt-mi-2line">
                  {t(p.title)}
                  <small>{t(p.hint)}</small>
                </span>
              </span>
              {privacy === p.key && <span className="nt-mi-hint">✓</span>}
            </button>
          ))}
        </div>
        {ts && (
          <div>
            <div className="nt-menu-label" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              {t("ts.members")}
              {canManage && candidates.length + groupCandidates.length > 0 && (
                <button type="button" className="nt-btn nt-btn-plain nt-btn-sm nt-btn-reset" onClick={(e) => setAdd(e.currentTarget)}>
                  {t("ts.addMember")}
                </button>
              )}
            </div>
            {tsGroups.map((g) => (
              <div key={`g-${g.groupId}`} className="nt-share-person">
                <span className="nt-share-general-icon">
                  <Users size={16} />
                </span>
                <span className="nt-share-person-name">
                  {g.name}
                  <small>{t("groups.title")}</small>
                </span>
                {canManage && (
                  <button type="button" className="nt-btn nt-btn-plain nt-btn-sm nt-btn-reset" disabled={busy} onClick={() => void run({ op: "removeGroup", id: ts.id, groupId: g.groupId }, loadMembers)}>
                    {t("access.remove")}
                  </button>
                )}
              </div>
            ))}
            {(members ?? []).map((m) => (
              <div key={m.userId} className="nt-share-person">
                <span className="nt-cm-avatar">{initials(m.name)}</span>
                <span className="nt-share-person-name">
                  {m.name}
                  {m.userId === user?.id ? ` ${t("access.you")}` : ""}
                  <small>{m.role === "owner" ? t("ts.owner") : t("ts.member")}</small>
                </span>
                {canManage && m.userId !== user?.id && (
                  <button type="button" className="nt-btn nt-btn-plain nt-btn-sm nt-btn-reset" disabled={busy} onClick={() => void run({ op: "remove", id: ts.id, userId: m.userId }, loadMembers)}>
                    {t("access.remove")}
                  </button>
                )}
              </div>
            ))}
            {add && (
              <Popover anchor={add} onClose={() => setAdd(null)} placement="bottom-end">
                <Menu
                  width={280}
                  onClose={() => setAdd(null)}
                  groups={[
                    ...(groupCandidates.length
                      ? [
                          {
                            key: "groups",
                            label: t("groups.title"),
                            items: groupCandidates.map((g) => ({
                              key: `g-${g.id}`,
                              label: g.name,
                              hint: t("groups.members", { n: g.members }),
                              icon: <Users />,
                              onSelect: () => {
                                setAdd(null);
                                void run({ op: "addGroup", id: ts.id, groupId: g.id }, loadMembers);
                              },
                            })),
                          },
                        ]
                      : []),
                    {
                      key: "people",
                      items: candidates.map((p) => ({
                        key: p.id,
                        label: p.name,
                        icon: <span className="nt-cm-avatar">{initials(p.name)}</span>,
                        onSelect: () => {
                          setAdd(null);
                          void run({ op: "add", id: ts.id, userId: p.id }, loadMembers);
                        },
                      })),
                    },
                  ]}
                />
              </Popover>
            )}
          </div>
        )}
        <div className="nt-share-row">
          {ts ? (
            <>
              {ts.role && (
                <button type="button" className="nt-btn nt-btn-plain nt-btn-sm nt-btn-reset" disabled={busy} onClick={() => void run({ op: "remove", id: ts.id, userId: user?.id }, onClose)}>
                  {t("ts.leave")}
                </button>
              )}
              {canManage && (
                <button type="button" className="nt-btn nt-btn-plain nt-btn-sm nt-btn-reset" disabled={busy} title={t("ts.archivedHint")} onClick={() => void run({ op: ts.archived ? "unarchive" : "archive", id: ts.id }, onClose)}>
                  {ts.archived ? t("ts.unarchive") : t("ts.archive")}
                </button>
              )}
              {canManage && (
                <button type="button" className="nt-btn nt-btn-danger nt-btn-sm nt-btn-reset" disabled={busy} onClick={() => void run({ op: "delete", id: ts.id }, onClose)}>
                  {t("ts.delete")}
                </button>
              )}
            </>
          ) : (
            <button type="button" className="nt-btn nt-btn-primary nt-btn-reset" disabled={busy || !name.trim()} onClick={() => void run({ op: "create", name: name.trim(), privacy }, onClose)}>
              {t("ts.create")}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** "Browse teamspaces": the ones the person is not in (an open one can be joined), and the archived ones. */
export function BrowseTeamspaces({ anchor, onClose, onSettings }: { anchor: HTMLElement; onClose: () => void; onSettings: (ts: NotesTeamspace) => void }) {
  const api = useNotes();
  const { t, user, teamspaces } = api;
  const others = teamspaces.filter((x) => !x.role && !x.archived);
  const archived = teamspaces.filter((x) => x.archived);
  return (
    <Popover anchor={anchor} onClose={onClose} placement="right-start">
      <Menu
        width={280}
        onClose={onClose}
        groups={[
          {
            key: "ts",
            label: t("ts.browse"),
            items: others.length
              ? others.map((x) => ({
                  key: x.id,
                  label: x.name,
                  icon: <span className="nt-cm-avatar">{initials(x.name)}</span>,
                  hint: x.privacy === "open" ? t("ts.join") : t("ts.closed"),
                  disabled: x.privacy !== "open",
                  onSelect: () => {
                    onClose();
                    void call(user?.ws.id ?? "", { op: "join", id: x.id }).then((r) => {
                      if (!r || r.error) return toast(t("ts.failed"));
                      api.reloadTeamspaces();
                      api.syncNow();
                    });
                  },
                }))
              : [{ key: "none", label: t("ts.none"), disabled: true }],
          },
          ...(archived.length
            ? [
                {
                  key: "archived",
                  label: t("ts.archived"),
                  items: archived.map((x) => ({ key: `a-${x.id}`, label: x.name, icon: <span className="nt-cm-avatar">{initials(x.name)}</span>, onSelect: () => onSettings(x) })),
                },
              ]
            : []),
        ]}
      />
    </Popover>
  );
}
