"use client";

// Settings of Projects: teams (create, general, workflow statuses, cycles
// and estimates, members, delete), labels and label groups, custom fields,
// and the first-run onboarding. Workspace roles stay on zvena's Team page.
// Laid out like zvena's own settings (app/settings): the sections on the
// left — the workspace's, then each team — and the open one on the right as
// rows of a title and hint with the control beside them.

import { useEffect, useState, type ReactNode } from "react";
import { GripVertical, Inbox as InboxIcon, ListChecks, Plus, Settings as SettingsIcon, Tag, Trash2, Users, Wand2 } from "lucide-react";
import { Row, Section } from "@/app/settings/parts";
import "@/app/settings/settings.css";
import { Switch } from "@/components/zvena/ds";
import { suggestKey } from "@/lib/projects/ident";
import { ESTIMATE_SCALES, FIELD_TYPES, PALETTE, STATUS_CATEGORIES, TEAM_KEY_RE, type EstimateScale, type FieldType, type StatusCategory, type Team } from "@/lib/projects/types";
import { api, errorText, invalidateAll, loadBoot, toast, useLookups } from "./data";
import { Glyph, StatusIcon, uiColor } from "./icons";
import { useT } from "./i18n";
import { Link, navigate, useLoc } from "./router";
import { Avatar, confirmDialog, Empty, LoadingRows, Menu, Popover, usePopover, type MenuItem } from "./ui";

async function call(path: string, method: string, body: unknown, t: ReturnType<typeof useT>["t"]): Promise<boolean> {
  try {
    await api(path, { method, body });
    await loadBoot();
    invalidateAll();
    return true;
  } catch (e) {
    toast(errorText(e, t), "error");
    return false;
  }
}

function ColorDots({ value, onPick }: { value: string; onPick: (c: string) => void }) {
  return (
    <span className="pj-colors" role="radiogroup">
      {PALETTE.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={c === value} aria-label={c} className="pj-color" data-on={c === value || undefined} style={{ background: c }} onClick={() => onPick(c)} />
      ))}
    </span>
  );
}

type SettingsTab = "teams" | "labels" | "fields" | "members" | "assistant";

export function SettingsScreen({ tab, teamKey }: { tab?: string; teamKey?: string }) {
  const { t } = useT();
  const L = useLookups();
  const cur: SettingsTab | "team" = teamKey ? "team" : tab === "labels" || tab === "fields" || tab === "members" || tab === "assistant" ? tab : "teams";
  const ws: [SettingsTab, string, ReactNode][] = [
    ["teams", t("st.teams"), <Users key="i" />],
    ["labels", t("st.labels"), <Tag key="i" />],
    ["fields", t("st.fields"), <ListChecks key="i" />],
    ["members", t("st.members"), <Users key="i" />],
    ["assistant", t("as.settingsTab"), <Wand2 key="i" />],
  ];
  const mine = L.b.teams.filter((tm) => tm.members.some((m) => m.userId === L.b.me.id));
  const others = L.b.teams.filter((tm) => !mine.includes(tm));
  const teamLink = (tm: Team) => (
    <Link key={tm.id} to={`/settings/team/${tm.key}`} className="zst-nav-link" aria-current={cur === "team" && teamKey === tm.key ? "page" : undefined}>
      <Glyph icon={tm.icon} color={tm.color} text={tm.name} size={16} />
      <span className="pj-st-nav-text">{tm.name}</span>
    </Link>
  );
  return (
    <div className="pj-screen">
      <header className="pj-head">
        <div className="pj-head-title">
          <SettingsIcon size={16} aria-hidden />
          <h1>{t("st.title")}</h1>
        </div>
      </header>
      <div className="pj-screen-body pj-st">
        <nav className="zst-nav pj-st-nav" aria-label={t("st.title")}>
          <div className="zst-nav-label">{t("nav.workspace")}</div>
          {ws.map(([k, label, icon]) => (
            <Link key={k} to={`/settings/${k}`} className="zst-nav-link" aria-current={cur === k ? "page" : undefined}>
              {icon}
              <span className="pj-st-nav-text">{label}</span>
            </Link>
          ))}
          {mine.length > 0 && <div className="zst-nav-label">{t("nav.teams")}</div>}
          {mine.map(teamLink)}
          {others.length > 0 && <div className="zst-nav-label">{t("nav.otherTeams")}</div>}
          {others.map(teamLink)}
        </nav>
        <div className="zst-main pj-st-main">
          {!L.canEdit && <div className="zst-note">{t("i.readOnly")}</div>}
          {cur === "teams" && <TeamsSettings />}
          {cur === "team" && teamKey && <TeamSettings teamKey={teamKey} />}
          {cur === "labels" && <LabelsSettings />}
          {cur === "fields" && <FieldsSettings />}
          {cur === "members" && <MembersSettings />}
          {cur === "assistant" && <AssistantSettings />}
        </div>
      </div>
    </div>
  );
}

function PageTitle({ title, lead, icon }: { title: string; lead?: string; icon?: ReactNode }) {
  return (
    <>
      <h2 className="pj-st-title">
        {icon}
        {title}
      </h2>
      {lead && <p className="zst-lead">{lead}</p>}
    </>
  );
}

/** The first screen: a board where it fits, the list on a phone (a board's columns would hide the examples). */
function firstLayout(): "board" | "list" {
  return typeof window !== "undefined" && window.innerWidth < 640 ? "list" : "board";
}

export function NewTeamForm({ onDone, compact }: { onDone?: (team: Team) => void; compact?: boolean }) {
  const { t } = useT();
  const L = useLookups();
  const [name, setName] = useState(compact ? L.b.ws.name : "");
  const [key, setKey] = useState(compact ? suggestKey(L.b.ws.name) : "");
  const [keyTouched, setKeyTouched] = useState(false);
  const [priv, setPriv] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const team = await api<Team>("teams", { method: "POST", body: { name, key, private: priv } });
      await loadBoot();
      onDone?.(team);
    } catch (e) {
      toast(errorText(e, t), "error");
    } finally {
      setBusy(false);
    }
  };
  const valid = name.trim() && TEAM_KEY_RE.test(key);
  return (
    <form
      className="pj-form pj-team-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void submit();
      }}
    >
      <label className="pj-field">
        <span>{t("st.teamName")}</span>
        <input
          className="pj-input"
          autoFocus
          value={name}
          maxLength={80}
          onChange={(e) => {
            setName(e.target.value);
            if (!keyTouched) setKey(suggestKey(e.target.value));
          }}
        />
      </label>
      <label className="pj-field">
        <span>{t("st.teamKey")}</span>
        <input
          className="pj-input pj-mono"
          value={key}
          maxLength={7}
          onChange={(e) => {
            setKeyTouched(true);
            setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""));
          }}
          aria-invalid={!TEAM_KEY_RE.test(key) || undefined}
        />
        <small className="pj-muted">{t("st.teamKeyHint", { key: key || "KEY" })}</small>
      </label>
      {!compact && (
        <Row title={t("st.private")} hint={t("st.privateHint")}>
          <Switch checked={priv} onChange={setPriv} label={t("st.private")} />
        </Row>
      )}
      <div className="pj-row-end">
        <button type="submit" className="pj-btn pj-btn-primary" disabled={!valid || busy}>
          {compact ? t("ob.create") : t("c.create")}
        </button>
      </div>
    </form>
  );
}

function TeamsSettings() {
  const { t } = useT();
  const L = useLookups();
  const loc = useLoc();
  const [adding, setAdding] = useState(loc.params.get("new") === "1");
  return (
    <>
      <PageTitle title={t("st.teams")} lead={t("st.teamsHint")} />
      {adding && L.canEdit && (
        <Section title={t("nav.newTeam")}>
          <NewTeamForm
            onDone={(team) => {
              setAdding(false);
              navigate(`/team/${team.key}/issues`);
            }}
          />
        </Section>
      )}
      <Section
        title={t("st.teams")}
        action={
          L.canEdit &&
          !adding && (
            <button type="button" className="pj-btn pj-btn-sm" onClick={() => setAdding(true)}>
              <Plus size={14} aria-hidden />
              {t("nav.newTeam")}
            </button>
          )
        }
      >
        {L.b.teams.map((tm) => (
          <Row
            key={tm.id}
            title={
              <Link to={`/settings/team/${tm.key}`} className="pj-st-team">
                <Glyph icon={tm.icon} color={tm.color} text={tm.name} size={20} />
                {tm.name}
              </Link>
            }
          >
            <span className="pj-row-id">{tm.key}</span>
            {tm.private && <span className="zst-badge">{t("st.private")}</span>}
            <span className="zst-muted pj-st-count">
              <Users size={12} aria-hidden /> {tm.members.length}
            </span>
          </Row>
        ))}
      </Section>
    </>
  );
}

function TeamSettings({ teamKey }: { teamKey: string }) {
  const { t } = useT();
  const L = useLookups();
  const team = L.teamByKey.get(teamKey);
  if (!team) return <Empty title={t("i.notFound")} />;
  return <TeamSettingsBody key={team.id} team={team} teamKey={teamKey} />;
}

function TeamSettingsBody({ team, teamKey }: { team: Team; teamKey: string }) {
  const { t } = useT();
  const L = useLookups();
  const [name, setName] = useState(team.name);
  const [key, setKey] = useState(team.key);
  const [icon, setIcon] = useState(team.icon ?? "");
  const [description, setDescription] = useState(team.description);
  const can = L.canEdit;
  const save = (body: Record<string, unknown>) =>
    void call(`teams/${team.id}`, "PATCH", body, t).then((ok) => {
      if (ok) {
        toast(t("st.saved"), "success");
        if (typeof body.key === "string" && body.key !== teamKey) navigate(`/settings/team/${body.key}`, { replace: true });
      }
    });
  const removeTeam = async () => {
    const n = await api<{ total: number }>("issues", { query: { inTeam: team.id, completed: "all", group: "none", sub: "1", limit: 1 } })
      .then((r) => String(r.total))
      .catch(() => "…");
    if (!(await confirmDialog({ title: t("st.deleteTeamConfirm", { name: team.name, n }), ok: t("st.deleteTeam"), danger: true }))) return;
    if (await call(`teams/${team.id}`, "DELETE", undefined, t)) navigate("/settings/teams");
  };
  return (
    <>
      <PageTitle title={team.name} icon={<Glyph icon={team.icon} color={team.color} text={team.name} size={24} />} />
      <Section title={t("st.general")}>
        <Row title={t("st.teamName")}>
          <input className="pj-input pj-st-input" value={name} readOnly={!can} aria-label={t("st.teamName")} maxLength={80} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== team.name && save({ name })} />
        </Row>
        <Row title={t("st.teamKey")} hint={t("st.teamKeyHint", { key })}>
          <input
            className="pj-input pj-mono pj-st-input pj-st-key"
            value={key}
            readOnly={!can}
            aria-label={t("st.teamKey")}
            maxLength={7}
            onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
            onBlur={() => TEAM_KEY_RE.test(key) && key !== team.key && save({ key })}
            aria-invalid={!TEAM_KEY_RE.test(key) || undefined}
          />
        </Row>
        <Row title={t("c.icon")}>
          <input className="pj-input pj-emoji-field" value={icon} readOnly={!can} aria-label={t("c.icon")} maxLength={4} onChange={(e) => setIcon(e.target.value)} onBlur={() => icon !== (team.icon ?? "") && save({ icon: icon || null })} />
        </Row>
        <Row title={t("c.color")}>
          <ColorDots value={team.color} onPick={(c) => can && save({ color: c })} />
        </Row>
        <Row title={t("c.description")}>
          <textarea className="pj-input pj-textarea pj-st-input" rows={2} value={description} readOnly={!can} aria-label={t("c.description")} onChange={(e) => setDescription(e.target.value)} onBlur={() => description !== team.description && save({ description })} />
        </Row>
        <Row title={t("st.private")} hint={t("st.privateHint")}>
          <Switch checked={team.private} onChange={(v) => save({ private: v })} label={t("st.private")} disabled={!can} />
        </Row>
      </Section>

      <Section title={t("nav.triage")}>
        <Row title={t("st.triageOn")} hint={t("st.triageHint")}>
          {team.triage && (
            <Link to={`/team/${team.key}/triage`} className="pj-btn pj-btn-sm">
              <InboxIcon size={14} aria-hidden />
              {t("st.openTriage")}
              {team.triageCount > 0 && <span className="pj-head-count">{team.triageCount}</span>}
            </Link>
          )}
          <Switch checked={team.triage} onChange={(v) => save({ triage: v })} label={t("st.triageOn")} disabled={!can} />
        </Row>
      </Section>

      <Workflow teamId={team.id} />

      <Section title={t("st.cycles")} hint={t("st.cyclesHint")}>
        <Row title={t("st.cyclesOn")}>
          <Switch checked={team.cyclesEnabled} onChange={(v) => save({ cyclesEnabled: v })} label={t("st.cyclesOn")} disabled={!can} />
        </Row>
        <Row title={t("st.cycleWeeks")}>
          <select className="pj-select" value={team.cycleWeeks} disabled={!can || !team.cyclesEnabled} aria-label={t("st.cycleWeeks")} onChange={(e) => save({ cycleWeeks: Number(e.target.value) })}>
            {[1, 2, 3, 4, 6, 8].map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </Row>
      </Section>

      <Section title={t("st.estimates")} hint={t("st.estimatesHint")}>
        <Row title={t("st.estimateScale")}>
          <select className="pj-select" value={team.estimates} disabled={!can} aria-label={t("st.estimateScale")} onChange={(e) => save({ estimates: e.target.value })}>
            {(Object.keys(ESTIMATE_SCALES) as EstimateScale[]).map((s) => (
              <option key={s} value={s}>
                {t(`est.${s}`)}
              </option>
            ))}
          </select>
        </Row>
      </Section>

      <TeamMembers team={team} />

      {L.isOwner && (
        <Section title={t("st.danger")}>
          <Row title={t("st.deleteTeam")} hint={t("st.deleteTeamHint")}>
            <button type="button" className="pj-btn pj-btn-danger" onClick={() => void removeTeam()}>
              <Trash2 size={14} aria-hidden />
              {t("st.deleteTeam")}
            </button>
          </Row>
        </Section>
      )}
    </>
  );
}

function Workflow({ teamId }: { teamId: string }) {
  const { t } = useT();
  const L = useLookups();
  const statuses = L.statusesOf(teamId);
  const [adding, setAdding] = useState<StatusCategory | null>(null);
  const [name, setName] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const can = L.canEdit;
  const remove = async (id: string) => {
    const s = L.status.get(id);
    const others = statuses.filter((x) => x.id !== id);
    const target = others.find((x) => x.category === s?.category) ?? others[0];
    if (!target) return;
    if (!(await confirmDialog({ title: `${t("st.deleteStatus")} «${target.name}»`, ok: t("c.delete"), danger: true }))) return;
    try {
      await api(`statuses/${id}`, { method: "DELETE", query: { moveTo: target.id } });
      await loadBoot();
      invalidateAll();
    } catch (e) {
      toast(errorText(e, t), "error");
    }
  };
  return (
    <Section title={t("st.workflow")} hint={t("st.workflowHint")}>
      <div className="pj-st-block">
      {STATUS_CATEGORIES.map((cat) => {
        const list = statuses.filter((s) => s.category === cat);
        return (
          <div key={cat} className="pj-wf-cat">
            <div className="pj-wf-head">
              <span>{t(`cat.${cat}`)}</span>
              {can && (
                <button type="button" className="pj-icon-btn pj-icon-xs" aria-label={t("st.addStatus")} title={t("st.addStatus")} onClick={() => setAdding(cat)}>
                  <Plus size={13} />
                </button>
              )}
            </div>
            {list.map((s, i) => (
              <div
                key={s.id}
                className="pj-wf-row"
                draggable={can}
                onDragStart={() => setDragId(s.id)}
                onDragOver={(e) => dragId && L.status.get(dragId)?.category === cat && e.preventDefault()}
                onDrop={() => {
                  if (!dragId || dragId === s.id) return;
                  const prev = list[i - 1];
                  const pos = prev && prev.id !== dragId ? (prev.position + s.position) / 2 : s.position - 1;
                  setDragId(null);
                  void call(`statuses/${dragId}`, "PATCH", { position: pos }, t);
                }}
              >
                {can && <GripVertical size={13} className="pj-muted-icon pj-grip" />}
                <StatusPopover status={s} canEdit={can} />
                <input
                  className="pj-input pj-input-sm pj-wf-name"
                  defaultValue={s.name}
                  readOnly={!can}
                  aria-label={t("st.statusName")}
                  onBlur={(e) => e.target.value.trim() && e.target.value !== s.name && void call(`statuses/${s.id}`, "PATCH", { name: e.target.value.trim() }, t)}
                />
                {can && list.length > 1 && (
                  <button type="button" className="pj-icon-btn pj-icon-xs" aria-label={t("c.delete")} onClick={() => void remove(s.id)}>
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))}
            {adding === cat && (
              <form
                className="pj-inline-add"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!name.trim()) return;
                  void call(`teams/${teamId}/statuses`, "POST", { name, category: cat }, t).then((ok) => {
                    if (ok) {
                      setName("");
                      setAdding(null);
                    }
                  });
                }}
              >
                <input className="pj-input pj-input-sm" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("st.statusName")} aria-label={t("st.statusName")} />
                <button type="submit" className="pj-btn pj-btn-sm pj-btn-primary" disabled={!name.trim()}>
                  {t("c.add")}
                </button>
              </form>
            )}
          </div>
        );
      })}
      </div>
      <DuplicateStatus teamId={teamId} />
    </Section>
  );
}

/** Where an issue marked as a duplicate goes (Linear's "Duplicate" status): one of the team's canceled statuses. */
function DuplicateStatus({ teamId }: { teamId: string }) {
  const { t } = useT();
  const L = useLookups();
  const team = L.team.get(teamId);
  const canceled = L.statusesOf(teamId).filter((s) => s.category === "canceled");
  if (!team || !canceled.length) return null;
  const value = team.duplicateStatusId && canceled.some((s) => s.id === team.duplicateStatusId) ? team.duplicateStatusId : canceled[0].id;
  return (
    <Row title={t("st.duplicateStatus")} hint={t("st.duplicateStatusHint")}>
      <select
        className="pj-select"
        value={value}
        disabled={!L.canEdit}
        aria-label={t("st.duplicateStatus")}
        onChange={(e) => void call(`teams/${teamId}`, "PATCH", { duplicateStatusId: e.target.value }, t).then((ok) => ok && toast(t("st.saved"), "success"))}
      >
        {canceled.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </Row>
  );
}

function StatusPopover({ status, canEdit }: { status: { id: string; category: StatusCategory; color: string }; canEdit: boolean }) {
  const { t } = useT();
  const L = useLookups();
  const pop = usePopover();
  return (
    <>
      <button type="button" className="pj-prop-btn" disabled={!canEdit} aria-label={t("c.color")} onClick={(e) => pop.toggle(e.currentTarget)}>
        <StatusIcon category={status.category} color={status.color} fraction={L.fraction(status.id)} />
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={220} label={t("c.color")}>
          <div className="pj-pad-sm">
            <ColorDots
              value={status.color}
              onPick={(c) => {
                pop.close();
                void call(`statuses/${status.id}`, "PATCH", { color: c }, t);
              }}
            />
          </div>
        </Popover>
      )}
    </>
  );
}

function TeamMembers({ team }: { team: Team }) {
  const { t } = useT();
  const L = useLookups();
  const pop = usePopover();
  const set = (userId: string, role: "lead" | "member" | null) => void call(`teams/${team.id}/members`, "POST", { userId, role }, t);
  const others = L.b.people.filter((p) => p.role && !team.members.some((m) => m.userId === p.id));
  const items: MenuItem[] = others.map((p) => ({ id: p.id, label: p.name, icon: <Avatar name={p.name} id={p.id} size={16} />, onSelect: () => set(p.id, "member") }));
  return (
    <Section
      title={t("st.teamMembers")}
      action={
        L.canEdit &&
        others.length > 0 && (
          <button type="button" className="pj-btn pj-btn-sm" onClick={(e) => pop.toggle(e.currentTarget)}>
            <Plus size={14} aria-hidden />
            {t("st.addMember")}
          </button>
        )
      }
    >
      <div className="pj-table">
        {team.members.map((m) => {
          const p = L.person.get(m.userId);
          const me = m.userId === L.b.me.id;
          return (
            <div key={m.userId} className="pj-table-row">
              <Avatar name={p?.name ?? "?"} id={m.userId} size={22} />
              <span className="pj-table-main">
                {p?.name ?? t("act.former")}
                {me && <span className="pj-muted"> ({t("c.you")})</span>}
              </span>
              <select className="pj-select pj-select-sm" value={m.role} disabled={!L.canEdit} onChange={(e) => set(m.userId, e.target.value as "lead" | "member")} aria-label={t("st.lead")}>
                <option value="lead">{t("st.lead")}</option>
                <option value="member">{t("st.member")}</option>
              </select>
              {(me || L.canEdit) && (
                <button type="button" className="pj-btn pj-btn-sm pj-btn-ghost" onClick={() => set(m.userId, null)}>
                  {me ? t("st.leave") : t("st.remove")}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={240} label={t("st.addMember")}>
          <Menu items={items} onClose={pop.close} />
        </Popover>
      )}
    </Section>
  );
}

function LabelsSettings() {
  const { t } = useT();
  const L = useLookups();
  const [name, setName] = useState("");
  const [color, setColor] = useState(PALETTE[0]);
  const [group, setGroup] = useState(false);
  const [parent, setParent] = useState("");
  const [teamId, setTeamId] = useState("");
  const groups = L.b.labels.filter((l) => l.isGroup);
  const create = async () => {
    if (!name.trim()) return;
    if (await call("labels", "POST", { name, color, isGroup: group, parentId: parent || undefined, teamId: teamId || null }, t)) setName("");
  };
  const top = L.b.labels.filter((l) => !l.parentId);
  return (
    <>
      <PageTitle title={t("st.labels")} lead={t("st.labelsHint")} />
      {L.canEdit && (
      <Section title={t("st.addLabel")}>
        <form
          className="pj-card-box pj-label-form"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input className="pj-input pj-input-sm" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("st.labelName")} aria-label={t("st.labelName")} maxLength={60} />
          <ColorDots value={color} onPick={setColor} />
          <select className="pj-select pj-select-sm" value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label={t("f.team")}>
            <option value="">{t("st.workspaceLabel")}</option>
            {L.b.teams.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
          {!group && groups.length > 0 && (
            <select className="pj-select pj-select-sm" value={parent} onChange={(e) => setParent(e.target.value)} aria-label={t("st.labelGroup")}>
              <option value="">—</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          )}
          <label className="pj-check-row pj-small" title={t("st.labelGroupHint")}>
            <input type="checkbox" checked={group} onChange={(e) => setGroup(e.target.checked)} />
            {t("st.labelGroup")}
          </label>
          <button type="submit" className="pj-btn pj-btn-sm pj-btn-primary" disabled={!name.trim()}>
            {t("st.addLabel")}
          </button>
        </form>
      </Section>
      )}
      <Section title={t("st.labels")}>
      <div className="pj-table">
        {top.map((l) => (
          <div key={l.id}>
            <LabelRow id={l.id} />
            {l.isGroup &&
              L.b.labels
                .filter((c) => c.parentId === l.id)
                .map((c) => (
                  <div key={c.id} className="pj-label-child">
                    <LabelRow id={c.id} />
                  </div>
                ))}
          </div>
        ))}
      </div>
      </Section>
    </>
  );
}

function LabelRow({ id }: { id: string }) {
  const { t } = useT();
  const L = useLookups();
  const l = L.label.get(id);
  const pop = usePopover();
  if (!l) return null;
  return (
    <div className="pj-table-row">
      <button type="button" className="pj-prop-btn" disabled={!L.canEdit} aria-label={t("c.color")} onClick={(e) => pop.toggle(e.currentTarget)}>
        <span className="pj-dot pj-dot-lg" style={{ background: uiColor(l.color) }} />
      </button>
      <input
        className="pj-input pj-input-sm pj-table-main"
        defaultValue={l.name}
        readOnly={!L.canEdit}
        aria-label={t("st.labelName")}
        onBlur={(e) => e.target.value.trim() && e.target.value !== l.name && void call(`labels/${l.id}`, "PATCH", { name: e.target.value.trim() }, t)}
      />
      {l.isGroup && <span className="pj-tag">{t("st.labelGroup")}</span>}
      {l.teamId && <span className="pj-tag">{L.team.get(l.teamId)?.key}</span>}
      {L.canEdit && (
        <button
          type="button"
          className="pj-icon-btn pj-icon-xs"
          aria-label={t("c.delete")}
          onClick={async () => {
            if (await confirmDialog({ title: `${t("c.delete")} «${l.name}»?`, ok: t("c.delete"), danger: true })) void call(`labels/${l.id}`, "DELETE", undefined, t);
          }}
        >
          <Trash2 size={13} />
        </button>
      )}
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={220} label={t("c.color")}>
          <div className="pj-pad-sm">
            <ColorDots
              value={l.color}
              onPick={(c) => {
                pop.close();
                void call(`labels/${l.id}`, "PATCH", { color: c }, t);
              }}
            />
          </div>
        </Popover>
      )}
    </div>
  );
}

function FieldsSettings() {
  const { t } = useT();
  const L = useLookups();
  const [name, setName] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const [options, setOptions] = useState("");
  const [teamId, setTeamId] = useState("");
  const create = async () => {
    if (!name.trim()) return;
    const body: Record<string, unknown> = { name, type, teamId: teamId || null };
    if (type === "select")
      body.options = options
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((n) => ({ name: n }));
    if (await call("fields", "POST", body, t)) {
      setName("");
      setOptions("");
    }
  };
  return (
    <>
      <PageTitle title={t("st.fields")} lead={t("st.fieldsHint")} />
      {L.canEdit && (
      <Section title={t("st.addField")}>
        <form
          className="pj-card-box pj-label-form"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input className="pj-input pj-input-sm" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("st.fieldName")} aria-label={t("st.fieldName")} maxLength={60} />
          <select className="pj-select pj-select-sm" value={type} onChange={(e) => setType(e.target.value as FieldType)} aria-label={t("st.fieldType")}>
            {FIELD_TYPES.map((x) => (
              <option key={x} value={x}>
                {t(`ft.${x}`)}
              </option>
            ))}
          </select>
          {type === "select" && <input className="pj-input pj-input-sm" value={options} onChange={(e) => setOptions(e.target.value)} placeholder={t("st.options")} aria-label={t("st.options")} />}
          <select className="pj-select pj-select-sm" value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label={t("f.team")}>
            <option value="">{t("st.workspaceLabel")}</option>
            {L.b.teams.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
          <button type="submit" className="pj-btn pj-btn-sm pj-btn-primary" disabled={!name.trim()}>
            {t("st.addField")}
          </button>
        </form>
      </Section>
      )}
      <Section title={t("st.fields")}>
      <div className="pj-table">
        {L.b.fields.map((f) => (
          <div key={f.id} className="pj-table-row">
            <span className="pj-tag">{t(`ft.${f.type}`)}</span>
            <span className="pj-table-main">{f.name}</span>
            {f.type === "select" && <span className="pj-small pj-muted">{f.options.map((o) => o.name).join(", ")}</span>}
            {f.teamId && <span className="pj-tag">{L.team.get(f.teamId)?.key}</span>}
            {L.canEdit && (
              <button
                type="button"
                className="pj-icon-btn pj-icon-xs"
                aria-label={t("c.delete")}
                onClick={async () => {
                  if (await confirmDialog({ title: `${t("c.delete")} «${f.name}»?`, ok: t("c.delete"), danger: true })) void call(`fields/${f.id}`, "DELETE", undefined, t);
                }}
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
      </Section>
    </>
  );
}

/** Smart suggestions and automations: the workspace-wide switch (the same one reactions use), shown and turned here by the owner. */
function AssistantSettings() {
  const { t } = useT();
  const L = useLookups();
  const [busy, setBusy] = useState(false);
  const state = L.b.smart ?? "unconfigured";
  const owner = L.b.ws.role === "owner";
  const set = async (on: boolean) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/decide?ws=${encodeURIComponent(L.b.ws.id)}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "smart", on }) });
      if (!res.ok) throw new Error(String(res.status));
      await loadBoot();
    } catch {
      toast(t("c.error"), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageTitle title={t("as.smartTitle")} />
      <Section title={t("as.smartTitle")}>
        {state === "unconfigured" ? (
          <p className="zst-note">{t("as.smartUnconfigured")}</p>
        ) : (
          <Row title={t("as.smartTitle")} hint={(state === "on" ? t("as.smartOn") : t("as.smartOff")) + (owner ? "" : ` ${t("as.smartOwnerOnly")}`)}>
            <Switch checked={state === "on"} onChange={(on) => void set(on)} label={t("as.smartTitle")} disabled={!owner || busy} />
          </Row>
        )}
      </Section>
    </>
  );
}

function MembersSettings() {
  const { t } = useT();
  const L = useLookups();
  return (
    <>
      <PageTitle title={t("st.members")} lead={t("st.wsMembers")} />
      <Section
        title={t("st.members")}
        action={
          <a className="pj-btn pj-btn-sm" href={`/team?ws=${encodeURIComponent(L.b.ws.id)}`}>
            <Users size={14} aria-hidden />
            {t("st.manageRoles")}
          </a>
        }
      >
      <div className="pj-table">
        {L.b.people
          .filter((p) => p.role)
          .map((p) => (
            <div key={p.id} className="pj-table-row">
              <Avatar name={p.name} id={p.id} size={22} src={p.avatar} />
              <span className="pj-table-main">{p.name}</span>
              <span className="pj-tag">{p.role}</span>
              <span className="pj-small pj-muted">
                {L.b.teams
                  .filter((x) => x.members.some((m) => m.userId === p.id))
                  .map((x) => x.key)
                  .join(", ")}
              </span>
            </div>
          ))}
      </div>
      </Section>
    </>
  );
}

let startRequested = false;

/**
 * First run: no form. An editor gets "My team" with three example issues and
 * lands on its board; a viewer is told to ask an editor.
 */
export function Onboarding() {
  const { t } = useT();
  const L = useLookups();
  const [failed, setFailed] = useState(false);
  const started = L.canEdit;
  useEffect(() => {
    // Once per page: a second request would only find the team already made.
    if (!L.canEdit || startRequested) return;
    startRequested = true;
    void api<{ team: Team }>("start", { method: "POST", body: {} })
      .then(async (r) => {
        await loadBoot();
        invalidateAll();
        navigate(`/team/${r.team.key}/issues?layout=${firstLayout()}`, { replace: true });
      })
      .catch(() => setFailed(true))
      .finally(() => {
        startRequested = false;
      });
  }, [L.canEdit]);
  return (
    <div className="pj-onboard">
      <div className="pj-onboard-card">
        <div className="pj-onboard-mark">
          <StatusIcon category="started" color="#2c84db" fraction={0.6} size={28} />
        </div>
        <h1>{t("ob.title")}</h1>
        <p className="pj-muted">{started && !failed ? t("ob.preparing") : t("ob.lead")}</p>
        {!L.canEdit ? (
          <div className="pj-banner">{t("ob.viewer")}</div>
        ) : failed ? (
          <NewTeamForm compact onDone={(team) => navigate(`/team/${team.key}/issues?layout=${firstLayout()}`)} />
        ) : (
          <LoadingRows rows={3} />
        )}
      </div>
    </div>
  );
}
