"use client";

// The "Share" tab of a page's Share menu (Notion): invite workspace members
// with a level, see who has access and change or remove it, General access
// ("Only people invited" or everyone in the workspace / teamspace), and an
// invite link for people outside the workspace (they join as guests).
// Everything here is checked again by the server (lib/notes/access.ts).

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Globe, Link, Lock, Mail, Users } from "lucide-react";
import { useNotes } from "./context";
import { useGroups } from "./GroupsPanel";
import { Menu, Popover, toast } from "./ui";
import { withWs } from "@/lib/notes/workspace";
import { initials, people } from "@/lib/notes/people";
import type { AccessLevel, Note } from "@/lib/notes/types";
import type { NotesKey } from "@/lib/notes/i18n";

interface AccessInfo {
  level: AccessLevel;
  restricted: boolean;
  restrictedFrom: string | null;
  space: string;
  grants: { userId: string; name: string; level: AccessLevel; guest: boolean }[];
  groups?: { groupId: string; name: string; level: AccessLevel; members: number }[];
  owner?: { userId: string; name: string };
  invites?: { id: string; level: Exclude<AccessLevel, "full">; expiresAt: number }[];
  /** Pending "Request access" (full access only). */
  requests?: { userId: string; name: string; at: number }[];
  /** E-mail can reach people from this server (else an invitation is a link for the inviter). */
  mailOn?: boolean;
}

const LEVELS: AccessLevel[] = ["full", "edit", "comment", "view"];
const LEVEL_KEY: Record<AccessLevel, NotesKey> = { full: "access.full", edit: "access.edit", comment: "access.comment", view: "access.view" };
const LEVEL_HINT: Record<AccessLevel, NotesKey> = { full: "access.fullHint", edit: "access.editHint", comment: "access.commentHint", view: "access.viewHint" };

/** A menu item with Notion's explanation line under it. */
function TwoLine({ title, sub }: { title: string; sub: string }) {
  return (
    <span className="nt-mi-2line">
      {title}
      <small>{sub}</small>
    </span>
  );
}

function Avatar({ name }: { name: string }) {
  return <span className="nt-cm-avatar">{initials(name || "?")}</span>;
}

/** Notion's level dropdown: the four levels (with what each allows) and, for a person, "Remove". */
function LevelPicker({ value, onPick, onRemove, disabled, only }: { value: AccessLevel; onPick: (l: AccessLevel) => void; onRemove?: () => void; disabled?: boolean; only?: AccessLevel[] }) {
  const { t } = useNotes();
  const [el, setEl] = useState<HTMLElement | null>(null);
  return (
    <>
      <button type="button" className="nt-share-level nt-btn-reset" disabled={disabled} onClick={(e) => setEl(e.currentTarget)}>
        {t(LEVEL_KEY[value])}
        {!disabled && <ChevronDown size={14} />}
      </button>
      {el && (
        <Popover anchor={el} onClose={() => setEl(null)} placement="bottom-end">
          <Menu
            width={260}
            onClose={() => setEl(null)}
            groups={[
              {
                key: "levels",
                items: (only ?? LEVELS).map((l) => ({ key: l, label: <TwoLine title={t(LEVEL_KEY[l])} sub={t(LEVEL_HINT[l])} />, checked: l === value, onSelect: () => (onPick(l), setEl(null)) })),
              },
              ...(onRemove ? [{ key: "rm", items: [{ key: "remove", label: t("access.remove"), danger: true, onSelect: () => (onRemove(), setEl(null)) }] }] : []),
            ]}
          />
        </Popover>
      )}
    </>
  );
}

export function ShareAccess({ note }: { note: Note }) {
  const api = useNotes();
  const { t, user } = api;
  const [info, setInfo] = useState<AccessInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [inviteLevel, setInviteLevel] = useState<AccessLevel>("edit");
  const [guestLink, setGuestLink] = useState<string | null>(null);
  const [linkLevel, setLinkLevel] = useState<Exclude<AccessLevel, "full">>("view");
  const [busy, setBusy] = useState(false);
  const url = (path: string) => withWs(`${path}?id=${encodeURIComponent(note.id)}`);
  const [tick, setTick] = useState(0);
  const load = useCallback(() => setTick((x) => x + 1), []);
  useEffect(() => {
    let live = true;
    void fetch(withWs(`/api/notes/access?id=${encodeURIComponent(note.id)}`), { credentials: "same-origin", cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<AccessInfo>;
      })
      .then((j) => {
        if (!live) return;
        setInfo(j);
        setFailed(false);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [note.id, tick]);
  const canShare = info?.level === "full";
  const post = async (body: Record<string, unknown>, path = "/api/notes/access") => {
    setBusy(true);
    try {
      const r = await fetch(url(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(String(r.status));
      return (await r.json()) as Record<string, unknown>;
    } catch {
      toast(t("access.failed"));
      return null;
    } finally {
      setBusy(false);
    }
  };
  const change = async (body: Record<string, unknown>) => {
    if (await post(body)) {
      load();
      // The page and its sub-pages come back from the server with the new levels.
      api.syncNow();
    }
  };
  // Members not on the list yet (workspace members only: guests join through a link).
  const candidates = useMemo(() => {
    const listed = new Set((info?.grants ?? []).map((g) => g.userId));
    return people().filter((p) => p.role && !listed.has(p.id) && p.id !== user?.id);
  }, [info, user?.id]);
  // Groups of the workspace (members see them; a guest's share menu lists people only).
  const member = Boolean(user && user.ws.role !== "guest" && !user.ws.personal);
  const { groups: allGroups } = useGroups(member && canShare);
  const groupCandidates = useMemo(() => {
    const listed = new Set((info?.groups ?? []).map((g) => g.groupId));
    return allGroups.filter((g) => !listed.has(g.id));
  }, [allGroups, info]);
  // "Add people, groups, or emails" (Notion): what the typed text matches.
  const q = query.trim().toLowerCase();
  const matchPeople = q ? candidates.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 8) : [];
  const matchGroups = q ? groupCandidates.filter((g) => g.name.toLowerCase().includes(q)).slice(0, 5) : [];
  const isEmail = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;.]{2,}$/.test(query.trim());
  const inviteEmail = async () => {
    const level = inviteLevel === "full" ? "edit" : inviteLevel;
    const r = await post({ op: "email", email: query.trim(), level }, "/api/notes/page-invite");
    if (!r) return;
    if (r.status === "link" && typeof r.url === "string") {
      // No mail service here: the inviter gets the link to send themselves.
      const url = r.url;
      await navigator.clipboard.writeText(url).then(
        () => toast(t("access.emailLinkCopied")),
        () => window.prompt(t("access.emailLinkCopied"), url)
      );
    } else toast(r.status === "granted" ? (r.mailed === false ? t("access.emailGrantedNoMail") : t("access.emailGranted")) : t("access.emailSent"));
    setQuery("");
    load();
    api.syncNow();
  };
  const wsName = user?.ws.name ?? "";
  const teamspace = info?.space.startsWith("ts:") ? api.teamspaces.find((x) => `ts:${x.id}` === info.space) : undefined;
  const everyone = teamspace ? t("access.everyoneIn", { name: teamspace.name }) : t("access.everyoneAt", { name: wsName });
  const privateOf = info?.space.startsWith("private:");

  if (failed) return <div className="nt-share-body nt-share-hint">{t("access.loadFailed")}</div>;
  if (!info) return <div className="nt-share-body nt-share-hint">…</div>;
  return (
    <div className="nt-share-body nt-share-access">
      {canShare && (
        <div className="nt-share-invite-wrap">
          <div className="nt-share-invite">
            <input
              className="nt-input nt-share-invite-input"
              value={query}
              placeholder={t("access.addPeopleEmail")}
              aria-label={t("access.addPeopleEmail")}
              disabled={busy}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && isEmail) {
                  e.preventDefault();
                  void inviteEmail();
                }
                if (e.key === "Escape") setQuery("");
              }}
            />
            <LevelPicker value={inviteLevel} onPick={setInviteLevel} />
          </div>
          {query.trim() && (
            <div className="nt-share-suggest" role="listbox">
              {matchGroups.map((g) => (
                <button
                  type="button"
                  key={`g-${g.id}`}
                  role="option"
                  aria-selected="false"
                  className="nt-share-person nt-btn-reset"
                  onClick={() => {
                    setQuery("");
                    void change({ op: "grant", groupId: g.id, level: inviteLevel });
                  }}
                >
                  <span className="nt-share-general-icon">
                    <Users size={16} />
                  </span>
                  <span className="nt-share-person-name">
                    {g.name}
                    <small>{t("groups.members", { n: g.members })}</small>
                  </span>
                </button>
              ))}
              {matchPeople.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  role="option"
                  aria-selected="false"
                  className="nt-share-person nt-btn-reset"
                  onClick={() => {
                    setQuery("");
                    void change({ op: "grant", userId: p.id, level: inviteLevel });
                  }}
                >
                  <Avatar name={p.name} />
                  <span className="nt-share-person-name">{p.name}</span>
                </button>
              ))}
              {isEmail && (
                <button type="button" role="option" aria-selected="false" className="nt-share-person nt-btn-reset" onClick={() => void inviteEmail()}>
                  <span className="nt-share-general-icon">
                    <Mail size={16} />
                  </span>
                  <span className="nt-share-person-name">
                    {t("access.inviteEmail", { email: query.trim() })}
                    <small>{info?.mailOn === false ? t("access.inviteEmailHintNoMail") : t("access.inviteEmailHint")}</small>
                  </span>
                </button>
              )}
              {!isEmail && matchGroups.length + matchPeople.length === 0 && <div className="nt-share-hint">{t("access.noMatches")}</div>}
            </div>
          )}
        </div>
      )}
      {canShare && (info.requests ?? []).length > 0 && (
        <div className="nt-share-requests">
          <div className="nt-menu-label">{t("access.requests")}</div>
          {(info.requests ?? []).map((r) => (
            <div key={r.userId} className="nt-share-person">
              <Avatar name={r.name} />
              <span className="nt-share-person-name">
                {r.name || "?"}
                <small>{t("access.requested")}</small>
              </span>
              <LevelPicker value={inviteLevel} only={["edit", "comment", "view"]} onPick={(level) => void change({ op: "approve", userId: r.userId, level })} />
              <button type="button" className="nt-btn nt-btn-primary nt-btn-sm nt-btn-reset" disabled={busy} onClick={() => void change({ op: "approve", userId: r.userId, level: inviteLevel === "full" ? "edit" : inviteLevel })}>
                {t("access.approve")}
              </button>
              <button type="button" className="nt-btn nt-btn-plain nt-btn-sm nt-btn-reset" disabled={busy} onClick={() => void change({ op: "decline", userId: r.userId })}>
                {t("access.decline")}
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="nt-share-people" role="list">
        {/* The workspace owner sees every page that is not someone's Private. */}
        {info.owner && !privateOf && (
          <div className="nt-share-person" role="listitem">
            <Avatar name={info.owner.name} />
            <span className="nt-share-person-name">
              {info.owner.name}
              {info.owner.userId === user?.id ? ` ${t("access.you")}` : ""}
              <small>{t("access.workspaceOwner")}</small>
            </span>
            <span className="nt-share-level" aria-disabled="true">
              {t("access.full")}
            </span>
          </div>
        )}
        {(info.groups ?? []).map((g) => (
          <div key={`g-${g.groupId}`} className="nt-share-person" role="listitem">
            <span className="nt-share-general-icon">
              <Users size={16} />
            </span>
            <span className="nt-share-person-name">
              {g.name}
              <small>{t("groups.members", { n: g.members })}</small>
            </span>
            <LevelPicker
              value={g.level}
              disabled={!canShare || busy}
              onPick={(level) => void change({ op: "grant", groupId: g.groupId, level })}
              onRemove={canShare ? () => void change({ op: "revoke", groupId: g.groupId }) : undefined}
            />
          </div>
        ))}
        {info.grants.map((g) => (
          <div key={g.userId} className="nt-share-person" role="listitem">
            <Avatar name={g.name} />
            <span className="nt-share-person-name">
              {g.name || "?"}
              {g.userId === user?.id ? ` ${t("access.you")}` : ""}
              {g.guest && <small className="nt-share-guest">{t("access.guest")}</small>}
            </span>
            <LevelPicker
              value={g.level}
              disabled={!canShare || busy}
              onPick={(level) => void change({ op: "grant", userId: g.userId, level })}
              onRemove={canShare || g.userId === user?.id ? () => void change({ op: "revoke", userId: g.userId }) : undefined}
            />
          </div>
        ))}
      </div>
      <div className="nt-menu-label">{t("access.general")}</div>
      <div className="nt-share-person">
        <span className="nt-share-general-icon">{info.restricted || info.restrictedFrom || privateOf ? <Lock size={16} /> : teamspace ? <Users size={16} /> : <Globe size={16} />}</span>
        <span className="nt-share-person-name">
          {privateOf ? t("access.private") : info.restricted || info.restrictedFrom ? t("access.onlyInvited") : everyone}
          <small>
            {privateOf
              ? t("access.privateHint")
              : info.restricted || info.restrictedFrom
                ? t("access.onlyInvitedHint")
                : t("access.everyoneHint")}
          </small>
        </span>
        {canShare && !privateOf && !info.restrictedFrom && (
          <GeneralPicker restricted={info.restricted} everyone={everyone} onPick={(restricted) => void change({ op: "general", restricted })} />
        )}
      </div>
      {canShare && (
        <>
          <div className="nt-menu-label">{t("access.guests")}</div>
          {guestLink ? (
            <div className="nt-share-link">
              <input className="nt-input" readOnly value={guestLink} onFocus={(e) => e.currentTarget.select()} />
              <button
                type="button"
                className="nt-btn nt-btn-primary nt-btn-sm nt-btn-reset"
                onClick={() => {
                  void navigator.clipboard?.writeText(guestLink).catch(() => undefined);
                  toast(t("share.copied"));
                }}
              >
                <Link size={14} />
                {t("share.copy")}
              </button>
            </div>
          ) : (
            <div className="nt-share-invite nt-share-guest-row">
              <span className="nt-share-hint" style={{ margin: 0, textAlign: "left" }}>
                {t("access.guestHint")}
              </span>
              <LevelPicker value={linkLevel} only={["edit", "comment", "view"]} onPick={(l) => setLinkLevel(l as Exclude<AccessLevel, "full">)} />
              <button
                type="button"
                className="nt-btn nt-btn-plain nt-btn-sm nt-btn-reset"
                disabled={busy}
                onClick={async () => {
                  const r = await post({ op: "create", level: linkLevel }, "/api/notes/page-invite");
                  if (r && typeof r.url === "string") {
                    setGuestLink(r.url);
                    load();
                  }
                }}
              >
                {t("access.createLink")}
              </button>
            </div>
          )}
          {(info.invites ?? []).length > 0 && (
            <div className="nt-share-hint" style={{ textAlign: "left", margin: "6px 0 0" }}>
              {t("access.liveLinks", { n: (info.invites ?? []).length })}{" "}
              <button
                type="button"
                className="nt-btn nt-btn-plain nt-btn-sm nt-btn-reset"
                disabled={busy}
                onClick={async () => {
                  for (const inv of info.invites ?? []) await post({ op: "revoke", inviteId: inv.id }, "/api/notes/page-invite");
                  setGuestLink(null);
                  load();
                }}
              >
                {t("access.revokeLinks")}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function GeneralPicker({ restricted, everyone, onPick }: { restricted: boolean; everyone: string; onPick: (restricted: boolean) => void }) {
  const { t } = useNotes();
  const [el, setEl] = useState<HTMLElement | null>(null);
  return (
    <>
      <button type="button" className="nt-share-level nt-btn-reset" onClick={(e) => setEl(e.currentTarget)}>
        <ChevronDown size={14} />
      </button>
      {el && (
        <Popover anchor={el} onClose={() => setEl(null)} placement="bottom-end">
          <Menu
            width={280}
            onClose={() => setEl(null)}
            groups={[
              {
                key: "general",
                items: [
                  { key: "invited", label: <TwoLine title={t("access.onlyInvited")} sub={t("access.onlyInvitedHint")} />, icon: <Lock />, checked: restricted, onSelect: () => (onPick(true), setEl(null)) },
                  { key: "everyone", label: <TwoLine title={everyone} sub={t("access.everyoneHint")} />, icon: <Globe />, checked: !restricted, onSelect: () => (onPick(false), setEl(null)) },
                ],
              },
            ]}
          />
        </Popover>
      )}
    </>
  );
}
