"use client";

// zvena Mail — the app at /mail, inside zvena's one frame (Shell): the rail
// is shared and Mail adds its block (views, labels, mailboxes). Notion Mail's
// layout: views as tabs over the list, the conversation beside it (or over
// it, on a phone or with the full-page pane), composers as windows in the
// corner, replies docked under their conversation.
//
// Keys (Notion Mail, Superhuman, Gmail): C compose, / search, ⌘K commands,
// ? help, J/K next/previous, Enter open, Esc back, X select, E archive,
// # trash, ! spam, R reply, A reply all, F forward, U read/unread, S star,
// H snooze, L label, V move, Z undo, G then I/U/S/T/D/A/Z/! to go places.

import "./mail.css";
import { useEffect, useRef, useState } from "react";
import { SquarePen } from "lucide-react";
import { Shell, isTyping, toasts } from "@/components/zvena/ds";
import type { SessionUser } from "@/lib/session";
import { CommandMenu, ShortcutsHelp } from "./Command";
import { Composers } from "./Compose";
import { act, getState, go, loadBoot, loadList, loadThread, openComposer, newDraftId, refreshAll, routeFromUrl, setState, startLive, useMail, type ActionName } from "./data";
import { draftFor } from "./format";
import { useMt } from "./i18n";
import { MailList } from "./List";
import { MailNav, ComposeButton } from "./Nav";
import { Reader } from "./Reader";
import { SettingsScreen } from "./Settings";
import { Welcome } from "./Welcome";
import { LabelPicker, SnoozePicker } from "./Pickers";
import type { Anchor } from "./ui";

export function MailApp({ user }: { user: SessionUser }) {
  useState(() => {
    setState({ ws: user.ws.id, route: typeof window !== "undefined" ? routeFromUrl(location.pathname, location.search) : { list: { view: "inbox" } } });
    return null;
  });
  const { t } = useMt();
  const boot = useMail((s) => s.boot);
  const bootError = useMail((s) => s.bootError);
  const route = useMail((s) => s.route);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [picker, setPicker] = useState<{ kind: "snooze" | "label" | "move"; anchor: Anchor; threads: string[] } | null>(null);

  useEffect(() => {
    void loadBoot();
    const r = getState().route;
    void loadList(r.list);
    if (r.thread) void loadThread(r.thread);
    const onPop = () => {
      const next = routeFromUrl(location.pathname, location.search);
      setState({ route: next });
      void loadList(next.list);
      if (next.thread) void loadThread(next.thread);
    };
    window.addEventListener("popstate", onPop);
    const stop = startLive(user.ws.id);
    return () => {
      window.removeEventListener("popstate", onPop);
      stop();
    };
  }, [user.ws.id]);

  useKeys({ openPalette: () => setPalette(true), openHelp: () => setHelp(true), openPicker: (kind, threads, anchor) => setPicker({ kind, threads, anchor }) });

  const hasAccounts = Boolean(boot?.accounts.length);
  return (
    <Shell
      user={user}
      section="mail"
      sectionNav={boot ? <MailNav /> : undefined}
      sectionTitle={t("app.name")}
      sectionAction={hasAccounts ? <ComposeButton /> : undefined}
      palette={false}
      createHotkey={false}
      onSearch={() => setPalette(true)}
      fill
    >
      <div className="zm-app" data-pane={boot?.prefs.pane ?? "split"} data-density={boot?.prefs.density ?? "compact"}>
        {!boot ? (
          <div className="zm-loading" aria-busy="true">
            {bootError !== null ? (
              <div className="zm-empty">
                <p>{t("err.load")}</p>
                <button type="button" className="zv-btn" onClick={() => void loadBoot()}>
                  {t("retry")}
                </button>
              </div>
            ) : (
              <div className="zm-skeleton" />
            )}
          </div>
        ) : route.settings ? (
          <SettingsScreen />
        ) : !hasAccounts ? (
          <Welcome />
        ) : (
          <div className="zm-body" data-reading={route.thread ? "" : undefined}>
            <MailList onPicker={(kind, threads, anchor) => setPicker({ kind, threads, anchor })} />
            <Reader onPicker={(kind, threads, anchor) => setPicker({ kind, threads, anchor })} />
          </div>
        )}
        {hasAccounts && !route.settings && (
          <button type="button" className="zm-fab" onClick={composeNew} aria-label={t("compose.new")} title={`${t("compose.new")} · C`}>
            <SquarePen size={20} />
          </button>
        )}
        <Composers />
        {palette && <CommandMenu onClose={() => setPalette(false)} onHelp={() => setHelp(true)} onPicker={(kind, threads, anchor) => setPicker({ kind, threads, anchor })} />}
        {help && <ShortcutsHelp onClose={() => setHelp(false)} />}
        {picker?.kind === "snooze" && <SnoozePicker anchor={picker.anchor} onClose={() => setPicker(null)} onPick={(until) => void act("snooze", picker.threads, { until })} />}
        {(picker?.kind === "label" || picker?.kind === "move") && <LabelPicker anchor={picker.anchor} threads={picker.threads} move={picker.kind === "move"} onClose={() => setPicker(null)} />}
      </div>
    </Shell>
  );
}

/** What an action acts on: the selection, else the open conversation, else the focused row. */
export function targets(): string[] {
  const s = getState();
  if (s.selected.length) return s.selected;
  if (s.route.thread) return [s.route.thread];
  return s.focused ? [s.focused] : [];
}

/** The rows of the list on screen, in order. */
function visibleIds(): string[] {
  const s = getState();
  const key = s.route.list.q ? `q:${s.route.list.q}` : s.route.list.label ? `label:${s.route.list.label}` : `view:${s.route.list.view ?? "inbox"}`;
  return (s.lists[key]?.threads ?? []).map((t) => t.id);
}

function centerAnchor(): Anchor {
  const el = document.querySelector<HTMLElement>("[data-zm-anchor]");
  return el ?? { x: window.innerWidth / 2 - 130, y: 120 };
}

/** Starts a reply, reply-all or forward of the open conversation's newest message. */
export function replyTo(mode: "reply" | "replyAll" | "forward", messageId?: string): void {
  const s = getState();
  const id = s.route.thread;
  const thread = id ? s.threads[id] : null;
  if (!thread || !s.boot) return;
  const msgs = thread.messages.filter((m) => !m.draft);
  const m = (messageId ? msgs.find((x) => x.id === messageId) : null) ?? [...msgs].reverse().find((x) => !x.mine) ?? msgs[msgs.length - 1];
  if (!m) return;
  const mine = new Set(s.boot.accounts.map((a) => a.email.toLowerCase()));
  const draft = draftFor(mode, m, mine, newDraftId());
  openComposer({ draft, inline: true, ...(mode === "forward" ? { forward: m.attachments.map((a) => a.id) } : {}), quoteOf: m.id });
}

export function composeNew(): void {
  const s = getState();
  const acct = s.boot?.accounts[0];
  if (!acct) return;
  openComposer({ draft: { id: newDraftId(), accountId: acct.id, to: [], cc: [], bcc: [], subject: "", html: "", attachments: [], mode: "new", updatedAt: Date.now() }, inline: false });
}

function useKeys(o: { openPalette: () => void; openHelp: () => void; openPicker: (kind: "snooze" | "label" | "move", threads: string[], anchor: Anchor) => void }) {
  const gPrefix = useRef(0);
  const opts = useRef(o);
  useEffect(() => {
    opts.current = o;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        opts.current.openPalette();
        return;
      }
      if (e.defaultPrevented || isTyping(e.target) || document.querySelector("[data-zm-overlay]")) return;
      if (mod || e.altKey) return;
      const s = getState();
      if (!s.boot) return;
      const key = e.key;
      const run = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      // G then a letter: go somewhere.
      if (Date.now() - gPrefix.current < 1200) {
        gPrefix.current = 0;
        const to: Record<string, string> = { i: "inbox", u: "unread", s: "starred", t: "sent", d: "drafts", a: "archive", z: "snoozed", "!": "spam", "#": "trash" };
        if (to[key]) return run(() => go({ list: { view: to[key] } }));
        if (key === ",") return run(() => go({ list: s.route.list, settings: true }));
        return;
      }
      if (key === "g") {
        gPrefix.current = Date.now();
        return;
      }
      const ids = visibleIds();
      const tg = targets();
      const moveFocus = (d: 1 | -1) => {
        if (!ids.length) return;
        const cur = s.route.thread ?? s.focused;
        const i = cur ? ids.indexOf(cur) : -1;
        const next = ids[Math.max(0, Math.min(ids.length - 1, i + d))] ?? ids[0];
        if (s.route.thread && s.boot?.prefs.pane !== "full" && window.innerWidth >= 900) go({ list: s.route.list, thread: next }, true);
        else if (s.route.thread) go({ list: s.route.list, thread: next }, true);
        else setState({ focused: next });
        document.querySelector(`[data-thread-row="${CSS.escape(next)}"]`)?.scrollIntoView({ block: "nearest" });
      };
      const actOn = (a: ActionName) => run(() => void act(a, tg));
      switch (key) {
        case "c":
          return run(composeNew);
        case "/":
          return run(() => document.querySelector<HTMLInputElement>(".zm-search input")?.focus());
        case "?":
          return run(opts.current.openHelp);
        case "j":
        case "ArrowDown":
          return run(() => moveFocus(1));
        case "k":
        case "ArrowUp":
          return run(() => moveFocus(-1));
        case "Enter":
        case "o":
          if (s.focused && !s.route.thread) return run(() => go({ list: s.route.list, thread: s.focused as string }));
          return;
        case "Escape":
          if (s.selected.length) return run(() => setState({ selected: [] }));
          if (s.route.thread) return run(() => go({ list: s.route.list }));
          return;
        case "x":
          if (s.focused || s.route.thread) {
            const id = (s.route.thread ?? s.focused) as string;
            return run(() => setState((st) => ({ selected: st.selected.includes(id) ? st.selected.filter((x) => x !== id) : [...st.selected, id] })));
          }
          return;
        case "e":
          return tg.length ? actOn(s.route.list.view === "archive" ? "inbox" : "archive") : undefined;
        case "#":
        case "Delete":
          return tg.length ? actOn(s.route.list.view === "trash" ? "delete" : "trash") : undefined;
        case "!":
          return tg.length ? actOn(s.route.list.view === "spam" ? "notspam" : "spam") : undefined;
        case "u": {
          if (!tg.length) return;
          const list = Object.values(s.lists).flatMap((l) => l.threads);
          const unread = tg.some((id) => list.find((x) => x.id === id)?.unread);
          return actOn(unread ? "read" : "unread");
        }
        case "I":
          return tg.length ? actOn("read") : undefined;
        case "U":
          return tg.length ? actOn("unread") : undefined;
        case "s": {
          if (!tg.length) return;
          const list = Object.values(s.lists).flatMap((l) => l.threads);
          const starred = tg.some((id) => list.find((x) => x.id === id)?.starred) || tg.some((id) => s.threads[id]?.messages.some((m) => m.flagged));
          return actOn(starred ? "unstar" : "star");
        }
        case "h":
          return tg.length ? run(() => opts.current.openPicker("snooze", tg, centerAnchor())) : undefined;
        case "l":
          return tg.length ? run(() => opts.current.openPicker("label", tg, centerAnchor())) : undefined;
        case "v":
          return tg.length ? run(() => opts.current.openPicker("move", tg, centerAnchor())) : undefined;
        case "r":
          return s.route.thread ? run(() => replyTo("reply")) : undefined;
        case "a":
          return s.route.thread ? run(() => replyTo("replyAll")) : undefined;
        case "f":
          return s.route.thread ? run(() => replyTo("forward")) : undefined;
        case "z": {
          const cur = toasts().get();
          if (cur?.undo) return run(() => void cur.undo?.());
          return;
        }
        case "R":
          return run(refreshAll);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
