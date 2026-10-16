// zvena Documents: what imported files mean, without touching the store —
// CSV (Notion, Asana, Jira, spreadsheets): columns and their types; Trello
// board JSON: a database plan (lists → statuses, labels → tags, due dates,
// checklists). components/notes/importer.ts turns the plans into pages.

import type { DbProperty, NoteColor, SelectOption } from "./types";

// ---------------------------------------------------------------------------
// CSV

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  const s = text.replace(/^﻿/, "");
  // Semicolon-separated (Excel in Russian locales) when the header has no commas.
  const firstLine = s.slice(0, s.search(/\r?\n|$/));
  const sep = !firstLine.includes(",") && firstLine.includes(";") ? ";" : ",";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim()));
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, "0");

/** A date cell as YYYY-MM-DD: ISO, 31.12.2026, 12/31/2026, 31/Dec/26 (Jira), "October 9, 2026" (Notion). */
export function toIsoDate(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const dm = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s);
  if (dm) return `${dm[3]}-${pad(Number(dm[2]))}-${pad(Number(dm[1]))}`;
  // Jira: 01/Oct/26 3:22 PM.
  const jira = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{2}|\d{4})\b/.exec(s);
  if (jira && MONTHS[jira[2].toLowerCase()]) {
    const y = jira[3].length === 2 ? 2000 + Number(jira[3]) : Number(jira[3]);
    return `${y}-${pad(MONTHS[jira[2].toLowerCase()])}-${pad(Number(jira[1]))}`;
  }
  // US: 12/31/2026.
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(s);
  if (us && Number(us[1]) <= 12) return `${us[3]}-${pad(Number(us[1]))}-${pad(Number(us[2]))}`;
  if (!/[A-Za-z]{3,}/.test(s)) return null;
  const d = new Date(s.split(" → ")[0].replace(/\s*\(.*\)$/, ""));
  return Number.isNaN(d.getTime()) ? null : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const DATE_RE = /^(\d{4}-\d{2}-\d{2})|^([A-Z][a-z]+ \d{1,2}, \d{4})|^(\d{1,2}\.\d{1,2}\.\d{4})|^(\d{1,2}\/[A-Za-z]{3}\/\d{2,4})|^(\d{1,2}\/\d{1,2}\/\d{4})/;
const SELECT_HEADER = /^(status|stage|state|priority|type|kind|category|issue type|resolution|section\/column|section|column|list|статус|этап|стадия|приоритет|тип|вид|категория|раздел|колонка)$/i;
const TAGS_HEADER = /^(tags|labels|теги|метки)$/i;
const DATE_HEADER = /(date|due|created|updated|modified|resolved|completed|start|end|дата|срок|создан|изменен|начало|окончание)/i;

/** The type of a CSV column from its values (and its name: Status, Tags, Due date…). */
export function inferType(values: string[], header = ""): DbProperty["type"] {
  const vals = values.map((v) => v.trim()).filter(Boolean);
  if (!vals.length) return DATE_HEADER.test(header) ? "date" : "text";
  if (SELECT_HEADER.test(header.trim()) && vals.every((v) => v.length < 60 && !v.includes(", "))) return "select";
  if (TAGS_HEADER.test(header.trim()) && vals.every((v) => v.length < 300)) return "multi_select";
  if (vals.every((v) => /^(yes|no|true|false|да|нет|✓|x|)$/i.test(v))) return "checkbox";
  if (vals.every((v) => /^-?[\d\s]+([.,]\d+)?%?$/.test(v))) return "number";
  if (vals.every((v) => DATE_RE.test(v) && toIsoDate(v))) return "date";
  if (vals.every((v) => /^https?:\/\//.test(v))) return "url";
  if (vals.every((v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v))) return "email";
  const unique = new Set(vals);
  if (vals.some((v) => v.includes(", ")) && unique.size <= Math.max(12, vals.length)) {
    const parts = new Set(vals.flatMap((v) => v.split(/,\s*/)));
    if (parts.size <= 30 && vals.every((v) => v.length < 120)) return "multi_select";
  }
  if (unique.size <= Math.min(15, Math.max(2, Math.ceil(vals.length * 0.6))) && vals.every((v) => v.length < 60)) return "select";
  return "text";
}

const TITLE_HEADER = /^(name|title|summary|task name|task|page|название|имя|заголовок|задача|тема)$/i;

/** The column that names the rows: Name / Summary / Title… (Asana, Jira), else the first. */
export function titleColumn(head: string[]): number {
  const i = head.findIndex((h) => TITLE_HEADER.test(h.trim()));
  return i >= 0 ? i : 0;
}

// ---------------------------------------------------------------------------
// Trello

export interface TrelloRowPlan {
  title: string;
  status: string | null;
  labels: string[];
  due: string | null;
  dueDone: boolean;
  members: string;
  description: string;
  checklists: { name: string; items: { text: string; done: boolean }[] }[];
  comments: { author: string; text: string; at: string }[];
  url: string;
}

export interface TrelloPlan {
  title: string;
  /** Lists in board order, as status options with their Notion group. */
  statuses: { id: string; name: string; group: "todo" | "doing" | "done" }[];
  labels: SelectOption[];
  rows: TrelloRowPlan[];
}

const TRELLO_COLORS: Record<string, NoteColor> = {
  green: "green",
  green_dark: "green",
  lime: "green",
  yellow: "yellow",
  yellow_dark: "yellow",
  orange: "orange",
  red: "red",
  purple: "purple",
  blue: "blue",
  sky: "blue",
  pink: "pink",
  black: "gray",
};

const DONE_LIST = /(done|complete|finished|closed|shipped|released|готов|сделан|выполнен|закрыт)/i;
const DOING_LIST = /(doing|progress|working|review|testing|в работе|в процессе|делаем|ревью|тест)/i;

interface TrelloJson {
  name?: unknown;
  lists?: { id?: unknown; name?: unknown; closed?: unknown; pos?: unknown }[];
  cards?: { id?: unknown; name?: unknown; desc?: unknown; idList?: unknown; idLabels?: unknown; due?: unknown; dueComplete?: unknown; closed?: unknown; idMembers?: unknown; pos?: unknown; shortUrl?: unknown }[];
  labels?: { id?: unknown; name?: unknown; color?: unknown }[];
  checklists?: { id?: unknown; idCard?: unknown; name?: unknown; pos?: unknown; checkItems?: { name?: unknown; state?: unknown; pos?: unknown }[] }[];
  members?: { id?: unknown; fullName?: unknown; username?: unknown }[];
  actions?: { type?: unknown; date?: unknown; data?: { text?: unknown; card?: { id?: unknown } }; memberCreator?: { fullName?: unknown } }[];
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Whether a JSON file is a Trello board export. */
export function isTrelloBoard(v: unknown): boolean {
  const j = v as TrelloJson | null;
  return !!j && typeof j === "object" && Array.isArray(j.lists) && Array.isArray(j.cards);
}

/** A Trello board export → a database plan (archived lists and cards stay out). */
export function trelloPlan(v: unknown, newId: () => string): TrelloPlan {
  const j = v as TrelloJson;
  const lists = (j.lists ?? []).filter((l) => l && !l.closed && str(l.id)).sort((a, b) => num(a.pos) - num(b.pos));
  const statuses = lists.map((l, i) => {
    const name = str(l.name) || `List ${i + 1}`;
    const group: "todo" | "doing" | "done" = DONE_LIST.test(name) ? "done" : DOING_LIST.test(name) ? "doing" : "todo";
    return { id: newId(), name, group, trello: str(l.id) };
  });
  const byList = new Map(statuses.map((s) => [s.trello, s.name]));
  const labelsById = new Map<string, SelectOption>();
  for (const l of j.labels ?? []) {
    const id = str(l.id);
    if (!id) continue;
    const name = str(l.name) || str(l.color) || "Label";
    if ([...labelsById.values()].some((o) => o.name === name)) {
      labelsById.set(id, [...labelsById.values()].find((o) => o.name === name) as SelectOption);
      continue;
    }
    labelsById.set(id, { id: newId(), name, color: TRELLO_COLORS[str(l.color)] ?? "default" });
  }
  const members = new Map((j.members ?? []).map((m) => [str(m.id), str(m.fullName) || str(m.username)]));
  const checklists = new Map<string, TrelloRowPlan["checklists"]>();
  for (const c of [...(j.checklists ?? [])].sort((a, b) => num(a.pos) - num(b.pos))) {
    const card = str(c.idCard);
    if (!card) continue;
    const items = [...(c.checkItems ?? [])].sort((a, b) => num(a.pos) - num(b.pos)).map((x) => ({ text: str(x.name), done: x.state === "complete" }));
    checklists.set(card, [...(checklists.get(card) ?? []), { name: str(c.name) || "Checklist", items }]);
  }
  const comments = new Map<string, TrelloRowPlan["comments"]>();
  for (const a of j.actions ?? []) {
    if (a?.type !== "commentCard") continue;
    const card = str(a.data?.card?.id);
    const text = str(a.data?.text);
    if (!card || !text) continue;
    // Trello lists actions newest first; a page reads oldest first.
    comments.set(card, [{ author: str(a.memberCreator?.fullName), text, at: str(a.date) }, ...(comments.get(card) ?? [])]);
  }
  const rows: TrelloRowPlan[] = (j.cards ?? [])
    .filter((c) => c && !c.closed && byList.has(str(c.idList)))
    .sort((a, b) => lists.findIndex((l) => l.id === a.idList) - lists.findIndex((l) => l.id === b.idList) || num(a.pos) - num(b.pos))
    .map((c) => {
      const id = str(c.id);
      const labelIds = Array.isArray(c.idLabels) ? (c.idLabels as unknown[]).map(str) : [];
      const memberIds = Array.isArray(c.idMembers) ? (c.idMembers as unknown[]).map(str) : [];
      const due = str(c.due);
      return {
        title: str(c.name) || "Untitled",
        status: byList.get(str(c.idList)) ?? null,
        labels: [...new Set(labelIds.map((x) => labelsById.get(x)?.id).filter((x): x is string => Boolean(x)))],
        due: due ? due.slice(0, 10) : null,
        dueDone: c.dueComplete === true,
        members: memberIds.map((m) => members.get(m)).filter(Boolean).join(", "),
        description: str(c.desc),
        checklists: checklists.get(id) ?? [],
        comments: comments.get(id) ?? [],
        url: str(c.shortUrl),
      };
    });
  const labels = [...new Map([...labelsById.values()].map((o) => [o.id, o])).values()];
  return { title: str(j.name) || "Trello", statuses: statuses.map(({ id, name, group }) => ({ id, name, group })), labels, rows };
}

const dirOf = (path: string) => (path.lastIndexOf("/") < 0 ? "" : path.slice(0, path.lastIndexOf("/")));

/**
 * A Notion export's databases with several data sources (Notion, 2025):
 * one CSV per source — "DB abc.csv" (the first) with the others inside
 * "DB abc/" (rows are .md there, so a CSV there is a data source), or only
 * CSVs in a folder no page owns (the first by name is the database, named
 * after the folder). For each further CSV: the CSV of its database; for the
 * first of a folder: { host: "", folder } (the database takes the folder's name).
 */
export function notionSources(paths: readonly string[]): Map<string, { host: string; folder?: string }> {
  const out = new Map<string, { host: string; folder?: string }>();
  const csvs = paths.filter((p) => /\.csv$/i.test(p) && !/_all\.csv$/i.test(p));
  const csvDirs = new Set(csvs.map((p) => p.replace(/\.csv$/i, "")));
  const pageDirs = new Set(paths.filter((p) => /\.(md|markdown|txt|html?)$/i.test(p)).map((p) => p.replace(/\.[^.]+$/, "")));
  const inDir = new Map<string, string[]>();
  for (const p of csvs) inDir.set(dirOf(p), [...(inDir.get(dirOf(p)) ?? []), p]);
  for (const [dir, list] of inDir) {
    if (!dir || pageDirs.has(dir)) continue;
    const sorted = [...list].sort((a, b) => a.localeCompare(b));
    if (csvDirs.has(dir)) for (const p of sorted) out.set(p, { host: `${dir}.csv` });
    else if (sorted.length > 1) {
      out.set(sorted[0], { host: "", folder: dir });
      for (const p of sorted.slice(1)) out.set(p, { host: sorted[0] });
    }
  }
  return out;
}
