"use client";

// Column permissions (Notion, "Edit permissions" in a property's menu): who
// may see a property's values and who may change them — everyone with access
// to the database, or only the people and groups listed. People with full
// access to the database always may. The server enforces it
// (lib/notes/column-perms.ts); this dialog only edits the lists.

import { useMemo, useState } from "react";
import { Lock, Users, X } from "lucide-react";
import type { DbCtl } from "./useDatabase";
import { Menu, Modal, Popover } from "../ui";
import { useGroups } from "../GroupsPanel";
import { initials, people } from "@/lib/notes/people";
import type { DbProperty } from "@/lib/notes/types";

type Mode = "everyone" | "listed";

function Who({ list, onChange, label }: { list: string[]; onChange: (l: string[]) => void; label: string }) {
  const { groups } = useGroups(true);
  const [pick, setPick] = useState<HTMLElement | null>(null);
  const names = useMemo(() => new Map([...people().map((p) => [p.id, p.name] as const), ...groups.map((g) => [`group:${g.id}`, g.name] as const)]), [groups]);
  const free = {
    people: people().filter((p) => p.role && !list.includes(p.id)),
    groups: groups.filter((g) => !list.includes(`group:${g.id}`)),
  };
  return (
    <div>
      <div className="nt-perm-chips" aria-label={label}>
        {list.map((id) => (
          <span key={id} className="nt-perm-chip">
            {id.startsWith("group:") ? <Users size={12} /> : <span className="nt-cm-avatar nt-cm-avatar-xs">{initials(names.get(id) ?? "?")}</span>}
            {names.get(id) ?? "?"}
            <button type="button" className="nt-icon-btn nt-btn-reset" aria-label="×" onClick={() => onChange(list.filter((x) => x !== id))}>
              <X size={12} />
            </button>
          </span>
        ))}
        <button type="button" className="nt-btn nt-btn-plain nt-btn-sm nt-btn-reset" onClick={(e) => setPick(e.currentTarget)}>
          +
        </button>
      </div>
      {pick && (
        <Popover anchor={pick} onClose={() => setPick(null)} placement="bottom-start">
          <Menu
            width={280}
            onClose={() => setPick(null)}
            groups={[
              ...(free.groups.length ? [{ key: "g", items: free.groups.map((g) => ({ key: g.id, label: g.name, icon: <Users />, onSelect: () => (onChange([...list, `group:${g.id}`]), setPick(null)) })) }] : []),
              { key: "p", items: free.people.map((p) => ({ key: p.id, label: p.name, icon: <span className="nt-cm-avatar">{initials(p.name)}</span>, onSelect: () => (onChange([...list, p.id]), setPick(null)) })) },
            ]}
          />
        </Popover>
      )}
    </div>
  );
}

export function ColumnPermsDialog({ ctl, prop, onClose }: { ctl: DbCtl; prop: DbProperty; onClose: () => void }) {
  const { t } = ctl.api;
  const [viewMode, setViewMode] = useState<Mode>(prop.perms?.view ? "listed" : "everyone");
  const [editMode, setEditMode] = useState<Mode>(prop.perms?.edit ? "listed" : "everyone");
  const [view, setView] = useState<string[]>(prop.perms?.view ?? []);
  const [edit, setEdit] = useState<string[]>(prop.perms?.edit ?? []);
  const save = () => {
    const perms = { ...(viewMode === "listed" ? { view } : {}), ...(editMode === "listed" ? { edit } : {}) };
    ctl.updateProp(prop.id, { perms: Object.keys(perms).length ? perms : undefined });
    onClose();
  };
  const modeMenu = (value: Mode, set: (m: Mode) => void) => (
    <select className="nt-input nt-input-sm" value={value} onChange={(e) => set(e.target.value as Mode)}>
      <option value="everyone">{t("cols.everyone")}</option>
      <option value="listed">{t("cols.listed")}</option>
    </select>
  );
  return (
    <Modal onClose={onClose} label={t("cols.title", { name: prop.name })} className="nt-perm-dialog">
      <div className="nt-perm-body">
        <h2 style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 6px", fontSize: 16 }}>
          <Lock size={16} />
          {t("cols.title", { name: prop.name })}
        </h2>
        <p className="nt-settings-hint">{t("cols.hint")}</p>
        <div className="nt-perm-row">
          <span>{t("cols.whoView")}</span>
          {modeMenu(viewMode, setViewMode)}
        </div>
        {viewMode === "listed" && <Who list={view} onChange={setView} label={t("cols.whoView")} />}
        <div className="nt-perm-row">
          <span>{t("cols.whoEdit")}</span>
          {modeMenu(editMode, setEditMode)}
        </div>
        {editMode === "listed" && <Who list={edit} onChange={setEdit} label={t("cols.whoEdit")} />}
        <div className="nt-share-row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button type="button" className="nt-btn nt-btn-plain nt-btn-reset" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="nt-btn nt-btn-primary nt-btn-reset" onClick={save}>
            {t("cols.save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
