"use client";

// ⌘K: Mail's command menu (Notion Mail, Superhuman) — act on what is open
// or selected, go to any view or label, compose, search mail for what was
// typed; and "?": every key on one sheet.

import { createPortal } from "react-dom";
import { Archive, Clock, FileText, Inbox as InboxIcon, Layers, ListTodo, Mail, MailOpen, Plus, Search, Settings, SquarePen, Star, Tag, Trash2, Keyboard, FolderInput } from "lucide-react";
import { Kbd } from "@/components/zvena/ds";
import type { SystemView } from "@/lib/mail-client/views";
import { act, getState, go, setState, useMail } from "./data";
import { useMt } from "./i18n";
import { composeNew, targets } from "./MailApp";
import { SYSTEM_ICON } from "./Nav";
import { Menu, type Anchor, type MenuItem } from "./ui";
import type { MailKey } from "@/lib/mail-client/strings";

type PickerFn = (kind: "snooze" | "label" | "move", threads: string[], anchor: Anchor) => void;

export function CommandMenu({ onClose, onHelp, onPicker }: { onClose: () => void; onHelp: () => void; onPicker: PickerFn }) {
  const { t } = useMt();
  const boot = useMail((s) => s.boot);
  if (!boot) return null;
  const tg = targets();
  const anchor = { x: window.innerWidth / 2 - 140, y: 140 };
  const items: MenuItem[] = [];
  items.push({ id: "compose", label: t("compose.new"), icon: <SquarePen size={15} />, keys: ["C"], run: composeNew });
  if (tg.length) {
    items.push(
      { id: "archive", label: t("act.archive"), icon: <Archive size={15} />, keys: ["E"], run: () => void act("archive", tg) },
      { id: "trash", label: t("act.trash"), icon: <Trash2 size={15} />, keys: ["#"], run: () => void act("trash", tg) },
      { id: "read", label: t("act.markRead"), icon: <MailOpen size={15} />, run: () => void act("read", tg) },
      { id: "unread", label: t("act.markUnread"), icon: <Mail size={15} />, keys: ["U"], run: () => void act("unread", tg) },
      { id: "star", label: t("act.star"), icon: <Star size={15} />, keys: ["S"], run: () => void act("star", tg) },
      { id: "snooze", label: t("act.snooze"), icon: <Clock size={15} />, keys: ["H"], run: () => onPicker("snooze", tg, anchor) },
      { id: "label", label: t("act.label"), icon: <Tag size={15} />, keys: ["L"], run: () => onPicker("label", tg, anchor) },
      { id: "move", label: t("act.move"), icon: <FolderInput size={15} />, keys: ["V"], run: () => onPicker("move", tg, anchor) }
    );
    if (tg.length === 1 && getState().route.thread === tg[0]) {
      items.push(
        { id: "docs", label: t("docs.save"), icon: <FileText size={15} />, run: () => setState({ dialog: "docs" }) },
        { id: "issue", label: t("issue.make"), icon: <ListTodo size={15} />, run: () => setState({ dialog: "issue" }) }
      );
    }
  }
  for (const v of boot.views) items.push({ id: `go-${v.id}`, label: t("cmd.goTo", { place: v.system ? t(`view.${v.id as SystemView}`) : v.name }), icon: v.system ? SYSTEM_ICON[v.id as SystemView] : <Layers size={15} />, run: () => go({ list: { view: v.id } }) });
  for (const l of boot.labels.slice(0, 60)) items.push({ id: `label-${l.id}`, label: t("cmd.goTo", { place: l.name }), icon: <Tag size={15} />, run: () => go({ list: { label: l.id } }) });
  items.push(
    { id: "settings", label: t("nav.settings"), icon: <Settings size={15} />, run: () => go({ list: getState().route.list, settings: true }) },
    { id: "connect", label: t("account.add"), icon: <Plus size={15} />, run: () => go({ list: getState().route.list, settings: true }) },
    { id: "keys", label: t("cmd.shortcuts"), icon: <Keyboard size={15} />, keys: ["?"], run: onHelp }
  );
  return createPortal(
    <div className="zm-scrim zm-cmd-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()} data-zm-overlay="">
      <div className="zm-cmd" role="dialog" aria-label={t("cmd.title")}>
        <CommandList items={items} onClose={onClose} />
      </div>
    </div>,
    document.body
  );
}

/** The menu with "Search mail for …" as the last line when something is typed. */
function CommandList({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const { t } = useMt();
  return (
    <Menu
      items={items}
      onClose={onClose}
      search
      placeholder={t("cmd.placeholder")}
      empty={t("cmd.none")}
      footer={
        <button
          type="button"
          className="zm-menu-item zm-cmd-search"
          onClick={() => {
            const q = (document.querySelector<HTMLInputElement>(".zm-cmd .zm-menu-search")?.value ?? "").trim();
            onClose();
            if (q) go({ list: { q } });
            else document.querySelector<HTMLInputElement>(".zm-search input")?.focus();
          }}
        >
          <span className="zm-menu-icon">
            <Search size={15} />
          </span>
          <span className="zm-menu-label">{t("cmd.searchMail")}</span>
          <Kbd keys={["/"]} />
        </button>
      }
    />
  );
}

const KEYS: { group: MailKey; keys: [string, MailKey][] }[] = [
  {
    group: "keys.navigate",
    keys: [
      ["J / K", "keys.nextPrev"],
      ["Enter", "keys.open"],
      ["Esc", "keys.back"],
      ["/", "keys.search"],
      ["⌘K", "keys.command"],
      ["G I", "keys.goInbox"],
      ["G S", "keys.goStarred"],
      ["G T", "keys.goSent"],
      ["G D", "keys.goDrafts"],
      ["G A", "keys.goArchive"],
    ],
  },
  {
    group: "keys.act",
    keys: [
      ["E", "keys.archive"],
      ["#", "keys.trash"],
      ["!", "keys.spam"],
      ["U", "keys.readUnread"],
      ["S", "keys.star"],
      ["H", "keys.snooze"],
      ["L", "keys.label"],
      ["V", "keys.move"],
      ["X", "keys.select"],
      ["Z", "keys.undo"],
    ],
  },
  {
    group: "keys.write",
    keys: [
      ["C", "keys.compose"],
      ["R", "keys.reply"],
      ["A", "keys.replyAll"],
      ["F", "keys.forward"],
      ["⌘ Enter", "keys.send"],
    ],
  },
];

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const { t } = useMt();
  return createPortal(
    <div className="zm-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()} data-zm-overlay="" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="zm-dialog zm-keys" role="dialog" aria-label={t("cmd.shortcuts")} tabIndex={-1} ref={(el) => el?.focus()}>
        <div className="zm-dialog-head">
          <div className="zm-dialog-title">
            <InboxIcon size={16} /> {t("cmd.shortcuts")}
          </div>
          <button type="button" className="zm-icon-btn" onClick={onClose} aria-label={t("close")}>
            ×
          </button>
        </div>
        <div className="zm-keys-grid">
          {KEYS.map((g) => (
            <div key={g.group}>
              <h3>{t(g.group)}</h3>
              {g.keys.map(([k, label]) => (
                <div key={k} className="zm-keys-row">
                  <span>{t(label)}</span>
                  <Kbd keys={k.split(" ")} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
