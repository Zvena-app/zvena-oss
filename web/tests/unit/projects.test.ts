import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import { sql } from "@/lib/store";
import { acceptInvite, createInvite, createWorkspace, deleteWorkspace } from "@/lib/workspaces";
import { ctxFor, PjError, type Ctx } from "@/lib/projects/core";
import { createIssue, deleteIssues, getIssueBrief, queryIssues, resolveIssueId, sendDueReminders, updateIssue, updateIssues } from "@/lib/projects/issues";
import { addAttachment, addComment, addRelation, attachmentFor, checkSignedLink, issueDetail, setSubscribed, signedLink, relationsOf, editComment } from "@/lib/projects/social";
import { createLabel, createStatus, createTeam, deleteStatus, deleteTeam, listStatuses, listTeams, setTeamMember, updateTeam } from "@/lib/projects/teams";
import { addProjectUpdate, completeCycle, createCycle, createProject, getCycle, getProject, updateProject } from "@/lib/projects/planning";
import { bootstrap, inbox, markNotifications, saveView, setFavorite, listViews, search, unreadCount } from "@/lib/projects/workspace";
import { parseQuery, stale, blockers, breakdown, digest, triage } from "@/lib/projects/assist";
import { filterFromParams, filterToParams, displayFromParams, displayToParams } from "@/lib/projects/filter";
import { suggestKey } from "@/lib/projects/ident";
import { startProjects } from "@/lib/projects/start";
import { exportProjects, myOpenIssues } from "@/lib/projects/export";
import { mentionsIn, newMentions, plainText } from "@/lib/projects/markdown";
import { addDays, dayOf, DEFAULT_DISPLAY, type Issue } from "@/lib/projects/types";

function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `pj-${name}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}

const owner = person("Ольга");
const editor = person("Егор");
const commenter = person("Катя");
const viewer = person("Виктор");
const stranger = person("Чужой");

const ws = createWorkspace(owner, "Продукт").id;
for (const [who, role] of [
  [editor, "editor"],
  [commenter, "commenter"],
  [viewer, "viewer"],
] as const) {
  const inv = createInvite(owner, ws, role);
  acceptInvite(who, inv.token);
}
const otherWs = createWorkspace(stranger, "Чужая компания").id;

const as = (u: string, w = ws, need: "read" | "comment" | "edit" | "manage" = "read"): Ctx => ctxFor(u, w, need);
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof PjError ? `${e.status} ${e.code}` : String(e);
  }
  return "ok";
};

const team = createTeam(as(owner), { name: "Платформа", key: "ZVN" }, "ru");
const statuses = listStatuses(as(owner)).filter((s) => s.teamId === team.id);
const st = (name: string) => statuses.find((s) => s.name === name)!.id;

test("a team comes with a workflow, a lead and default labels", () => {
  assert.equal(team.key, "ZVN");
  assert.deepEqual(
    statuses.map((s) => [s.name, s.category]),
    [
      ["Бэклог", "backlog"],
      ["К выполнению", "unstarted"],
      ["В работе", "started"],
      ["На проверке", "started"],
      ["Готово", "completed"],
      ["Отменено", "canceled"],
      ["Дубликат", "canceled"],
    ]
  );
  assert.deepEqual(team.members, [{ userId: owner, role: "lead" }]);
  assert.equal(code(() => createTeam(as(owner), { name: "Дубль", key: "ZVN" })), "409 key taken");
  assert.equal(code(() => createTeam(as(owner), { name: "Плохой", key: "zv n" })), "400 bad request");
  assert.equal(code(() => createTeam(as(viewer), { name: "Нельзя", key: "NO" })), "403 forbidden");
  assert.equal(suggestKey("Мобильное приложение"), "MP");
  assert.equal(suggestKey("Platform"), "PLA");
});

test("issues get human identifiers and sensible defaults", () => {
  const a = createIssue(as(editor), { teamId: team.id, title: "Первая задача" });
  const b = createIssue(as(editor), { teamId: team.id, title: "Вторая задача", priority: 2, assigneeId: editor });
  assert.equal(a.identifier, "ZVN-1");
  assert.equal(b.identifier, "ZVN-2");
  assert.equal(a.statusId, st("К выполнению"));
  assert.equal(a.priority, 0);
  assert.equal(a.creatorId, editor);
  assert.equal(resolveIssueId(as(viewer), "zvn-2"), b.id);
  assert.equal(code(() => createIssue(as(editor), { teamId: team.id, title: "   " })), "400 bad request");
  assert.equal(code(() => createIssue(as(editor), { teamId: team.id, title: "x", assigneeId: stranger })), "400 bad request");
  assert.equal(code(() => createIssue(as(editor), { teamId: team.id, title: "x", priority: 7 })), "400 bad request");
  assert.equal(code(() => createIssue(as(editor), { teamId: team.id, title: "x", dueDate: "2026-02-30" })), "400 bad request");
  assert.equal(code(() => createIssue(as(editor), { teamId: team.id, title: "x", estimate: 4 })), "400 bad request");
});

test("roles: viewers read, commenters comment, editors change", () => {
  const it = createIssue(as(editor), { teamId: team.id, title: "Права" });
  assert.equal(code(() => createIssue(as(viewer), { teamId: team.id, title: "Нельзя" })), "403 forbidden");
  assert.equal(code(() => updateIssue(as(commenter), it.id, { title: "Нельзя" })), "403 forbidden");
  assert.equal(code(() => addComment(as(viewer), it.id, { body: "Нельзя" })), "403 forbidden");
  assert.equal(code(() => addComment(as(commenter), it.id, { body: "Можно" })), "ok");
  assert.equal(code(() => deleteIssues(as(commenter), [it.id])), "403 forbidden");
  assert.equal(getIssueBrief(as(viewer), it.id).title, "Права");
});

test("isolation: another organisation's issues never resolve", () => {
  const it = createIssue(as(owner), { teamId: team.id, title: "Секрет" });
  assert.equal(code(() => as(stranger)), "403 forbidden");
  const theirs = as(stranger, otherWs);
  assert.equal(code(() => getIssueBrief(theirs, it.id)), "404 issue not found");
  assert.equal(code(() => updateIssue(ctxFor(stranger, otherWs, "edit"), it.id, { title: "Взлом" })), "404 issue not found");
  assert.equal(code(() => deleteIssues(theirs, [it.id])), "404 issue not found");
  assert.equal(code(() => issueDetail(theirs, it.id)), "404 issue not found");
  assert.equal(code(() => resolveIssueId(theirs, "ZVN-1") && getIssueBrief(theirs, resolveIssueId(theirs, "ZVN-1"))), "404 issue not found");
  // A team of another workspace cannot be used either.
  const their = createTeam(ctxFor(stranger, otherWs, "edit"), { name: "Их", key: "THEY" });
  assert.equal(code(() => createIssue(as(owner), { teamId: their.id, title: "x" })), "404 team not found");
  assert.equal(queryIssues(theirs, { filter: { q: "Секрет" } }).total, 0);
  assert.equal(search(theirs, "Секрет").issues.length, 0);
  assert.equal(getIssueBrief(as(owner), it.id).title, "Секрет");
});

test("private teams are hidden from non-members (except the owner)", () => {
  const ctx = as(editor);
  const priv = createTeam(ctx, { name: "Тайная", key: "SEC", private: true });
  const it = createIssue(ctx, { teamId: priv.id, title: "Тайная задача" });
  assert.ok(listTeams(as(owner)).some((t) => t.id === priv.id), "the owner sees every team");
  assert.ok(!listTeams(as(commenter)).some((t) => t.id === priv.id));
  assert.equal(code(() => getIssueBrief(as(commenter), it.id)), "404 issue not found");
  assert.equal(queryIssues(as(commenter), { filter: { q: "Тайная" } }).total, 0);
  assert.equal(code(() => setTeamMember(as(commenter), priv.id, commenter, "member")), "404 team not found");
  setTeamMember(as(editor), priv.id, commenter, "member");
  assert.equal(getIssueBrief(as(commenter), it.id).title, "Тайная задача");
  assert.equal(code(() => setTeamMember(as(commenter), priv.id, viewer, "member")), "403 forbidden");
  assert.equal(code(() => setTeamMember(as(editor), priv.id, editor, null)), "409 last lead");
});

test("status, priority and assignee changes keep history and timestamps", () => {
  const it = createIssue(as(editor), { teamId: team.id, title: "История" });
  updateIssue(as(editor), it.id, { statusId: st("В работе"), priority: 1, assigneeId: commenter });
  const started = getIssueBrief(as(editor), it.id);
  assert.ok(started.startedAt);
  assert.equal(started.completedAt, null);
  updateIssue(as(editor), it.id, { statusId: st("Готово") });
  const done = getIssueBrief(as(editor), it.id);
  assert.ok(done.completedAt);
  const kinds = issueDetail(as(editor), it.id).activity.map((a) => a.kind);
  assert.deepEqual(kinds, ["created", "priority", "assignee", "status", "status"]);
  assert.equal(code(() => updateIssue(as(editor), it.id, { statusId: "nope" })), "404 status not found");
});

test("labels: one per group, no group labels, team labels stay in their team", () => {
  const ctx = as(editor);
  const group = createLabel(ctx, { name: "Тип", isGroup: true });
  const a = createLabel(ctx, { name: "Фронтенд", parentId: group.id });
  const b = createLabel(ctx, { name: "Бэкенд", parentId: group.id });
  const loose = createLabel(ctx, { name: "Срочно-клиент" });
  assert.equal(code(() => createLabel(ctx, { name: "срочно-КЛИЕНТ" })), "409 name taken");
  const it = createIssue(ctx, { teamId: team.id, title: "Метки", labelIds: [a.id, loose.id] });
  assert.deepEqual(new Set(it.labelIds), new Set([a.id, loose.id]));
  assert.equal(code(() => updateIssue(ctx, it.id, { labelIds: [a.id, b.id] })), "400 bad request");
  assert.equal(code(() => updateIssue(ctx, it.id, { labelIds: [group.id] })), "400 bad request");
  // Adding a label of the same group swaps it (bulk "add label").
  updateIssue(ctx, it.id, { addLabelIds: [b.id] });
  assert.deepEqual(new Set(getIssueBrief(ctx, it.id).labelIds), new Set([b.id, loose.id]));
  // Filtering by the group matches any label in it.
  assert.ok(queryIssues(ctx, { filter: { label: [group.id] } }).groups.flatMap((g) => g.items).some((x) => x.id === it.id));
});

test("sub-issues and parent loops", () => {
  const ctx = as(editor);
  const parent = createIssue(ctx, { teamId: team.id, title: "Эпик" });
  const child = createIssue(ctx, { teamId: team.id, title: "Шаг 1", parentId: parent.id });
  const grand = createIssue(ctx, { teamId: team.id, title: "Шаг 1.1", parentId: child.id });
  createIssue(ctx, { teamId: team.id, title: "Шаг 2", parentId: parent.id, statusId: st("Готово") });
  assert.deepEqual(getIssueBrief(ctx, parent.id).subIssues, { total: 2, done: 1 });
  assert.equal(code(() => updateIssue(ctx, parent.id, { parentId: grand.id })), "409 parent loop");
  assert.equal(code(() => updateIssue(ctx, parent.id, { parentId: parent.id })), "409 parent loop");
  assert.equal(issueDetail(ctx, parent.id).children.length, 2);
  assert.equal(issueDetail(ctx, grand.id).parent?.id, child.id);
});

test("dependencies: blocks / blocked by, no loops, open blockers counted", () => {
  const ctx = as(editor);
  const api = createIssue(ctx, { teamId: team.id, title: "API" });
  const ui = createIssue(ctx, { teamId: team.id, title: "UI" });
  const release = createIssue(ctx, { teamId: team.id, title: "Релиз" });
  addRelation(ctx, ui.id, { type: "blocked_by", relatedId: api.id });
  addRelation(ctx, ui.id, { type: "blocks", relatedId: release.id });
  assert.equal(code(() => addRelation(ctx, release.id, { type: "blocks", relatedId: api.id })), "409 blocking loop");
  assert.equal(code(() => addRelation(ctx, api.id, { type: "blocks", relatedId: ui.id })), "409 relation exists");
  assert.equal(code(() => addRelation(ctx, api.id, { type: "related", relatedId: api.id })), "400 bad request");
  assert.equal(getIssueBrief(ctx, ui.id).blockedBy, 1);
  assert.equal(getIssueBrief(ctx, ui.id).blocking, 1);
  assert.deepEqual(
    relationsOf(ctx, ui.id).map((r) => [r.type, r.issue.id]),
    [
      ["blocked_by", api.id],
      ["blocks", release.id],
    ]
  );
  updateIssue(ctx, api.id, { statusId: st("Готово") });
  assert.equal(getIssueBrief(ctx, ui.id).blockedBy, 0, "a closed blocker no longer blocks");
  const ids = queryIssues(ctx, { filter: { blocked: true } }).groups.flatMap((g) => g.items.map((i) => i.id));
  assert.ok(ids.includes(release.id) && !ids.includes(ui.id));
});

test("filters, grouping, ordering and pagination run on the server", () => {
  const ctx = as(owner);
  const t2 = createTeam(ctx, { name: "Поиск", key: "SRCH" });
  const s2 = listStatuses(ctx).filter((s) => s.teamId === t2.id);
  for (let n = 1; n <= 25; n++)
    createIssue(ctx, {
      teamId: t2.id,
      title: `Индексация документа ${n}`,
      description: n === 7 ? "Нужна **транслитерация** запросов" : "",
      priority: (n % 5) as 0 | 1 | 2 | 3 | 4,
      assigneeId: n % 2 ? editor : null,
      statusId: n % 3 === 0 ? s2.find((s) => s.category === "started")!.id : undefined,
    });
  const only = { team: [t2.id] };
  const all = queryIssues(ctx, { filter: only, display: { group: "none" }, limit: 10 });
  assert.equal(all.total, 25);
  assert.equal(all.groups[0].items.length, 10);
  // Pages follow each other without gaps or repeats.
  const seen = new Set(all.groups[0].items.map((i) => i.id));
  let cursor = all.groups[0].cursor;
  while (cursor) {
    const next = queryIssues(ctx, { filter: only, display: { group: "none" }, limit: 10, group: "all", cursor });
    for (const i of next.groups[0].items) {
      assert.ok(!seen.has(i.id));
      seen.add(i.id);
    }
    cursor = next.groups[0].cursor;
  }
  assert.equal(seen.size, 25);
  const byStatus = queryIssues(ctx, { filter: only, display: { group: "status" } });
  assert.equal(byStatus.groups.find((g) => g.key === "started:In progress")?.count, 8);
  const mine = queryIssues(ctx, { filter: { ...only, assignee: [editor] }, display: { group: "none" } });
  assert.equal(mine.total, 13);
  const urgent = queryIssues(ctx, { filter: { ...only, priority: [1] }, display: { group: "none" } });
  assert.equal(urgent.total, 5);
  const ordered = queryIssues(ctx, { filter: only, display: { group: "none", order: "priority" }, limit: 25 }).groups[0].items;
  const rank = (i: Issue) => (i.priority === 0 ? 5 : i.priority);
  assert.ok(ordered.every((x, k) => k === 0 || rank(ordered[k - 1]) <= rank(x)));
  // Full text: a word inside the description, any case; the identifier too.
  const fts = queryIssues(ctx, { filter: { ...only, q: "ТРАНСЛИТЕРАЦ" }, display: { group: "none" } });
  assert.equal(fts.total, 1);
  assert.equal(queryIssues(ctx, { filter: { q: "SRCH-7" }, display: { group: "none" } }).groups[0].items[0].title, "Индексация документа 7");
  const p = filterToParams({ assignee: ["me", "none"], priority: [1, 2], q: "вход" });
  assert.equal(p.toString(), "q=%D0%B2%D1%85%D0%BE%D0%B4&assignee=me%2Cnone&priority=1%2C2");
  assert.deepEqual(filterFromParams(p), { q: "вход", assignee: ["me", "none"], priority: [1, 2] });
  const d = { ...DEFAULT_DISPLAY, layout: "board" as const, order: "priority" as const };
  assert.deepEqual(displayFromParams(displayToParams(d)), d);
  assert.deepEqual(filterFromParams(new URLSearchParams("priority=9,1&assignee=<script>&due=never")), { priority: [1] });
});

test("board: drag between neighbours and to another column persists", () => {
  const ctx = as(editor);
  const col = st("К выполнению");
  const [a, b, c] = ["A", "B", "C"].map((t) => createIssue(ctx, { teamId: team.id, title: `Карточка ${t}`, statusId: col }));
  const order = () =>
    queryIssues(ctx, { filter: { status: [col], q: "Карточка" }, display: { group: "status", order: "manual" } })
      .groups[0].items.map((i) => i.title.slice(-1))
      .join("");
  assert.equal(order(), "CBA");
  updateIssue(ctx, a.id, { position: { before: c.id, after: b.id } });
  assert.equal(order(), "CAB");
  updateIssue(ctx, c.id, { statusId: st("В работе"), position: { before: null, after: null } });
  assert.equal(order(), "AB");
  assert.equal(getIssueBrief(ctx, c.id).statusId, st("В работе"));
});

test("bulk changes, archive and delete", () => {
  const ctx = as(editor);
  const ids = [1, 2, 3].map((n) => createIssue(ctx, { teamId: team.id, title: `Пакет ${n}` }).id);
  updateIssues(ctx, ids, { priority: 3, assigneeId: editor, statusId: "category:completed" });
  for (const id of ids) {
    const it = getIssueBrief(ctx, id);
    assert.equal(it.priority, 3);
    assert.equal(it.statusId, st("Готово"));
  }
  assert.equal(code(() => updateIssues(ctx, ids, { title: "одинаковые" })), "400 bad request");
  updateIssues(ctx, ids.slice(0, 1), { archived: true });
  assert.ok(!queryIssues(ctx, { filter: { q: "Пакет" }, display: { group: "none" } }).groups[0].items.some((i) => i.id === ids[0]));
  assert.equal(queryIssues(ctx, { filter: { q: "Пакет", archived: true }, display: { group: "none" } }).total, 1);
  assert.equal(deleteIssues(ctx, ids), 3);
  assert.equal(code(() => getIssueBrief(ctx, ids[1])), "404 issue not found");
});

test("moving an issue to another team keeps its old identifier working", () => {
  const ctx = as(owner);
  const t3 = createTeam(ctx, { name: "Мобайл", key: "MOB" });
  const it = createIssue(ctx, { teamId: team.id, title: "Переезд", statusId: st("В работе") });
  const moved = updateIssue(ctx, it.id, { teamId: t3.id });
  assert.equal(moved.identifier, "MOB-1");
  assert.equal(listStatuses(ctx).find((s) => s.id === moved.statusId)?.category, "started");
  assert.equal(resolveIssueId(ctx, it.identifier), it.id);
  updateTeam(ctx, t3.id, { key: "APP" });
  assert.equal(getIssueBrief(ctx, it.id).identifier, "APP-1");
  assert.equal(resolveIssueId(ctx, "MOB-1"), it.id);
});

test("statuses: add, remove with the issues moved, keep one per category", () => {
  const ctx = as(editor);
  const qa = createStatus(ctx, team.id, { name: "QA", category: "started", color: "#26b5ce" });
  const it = createIssue(ctx, { teamId: team.id, title: "Тестирование", statusId: qa.id });
  deleteStatus(ctx, qa.id, st("В работе"));
  assert.equal(getIssueBrief(ctx, it.id).statusId, st("В работе"));
  assert.equal(code(() => deleteStatus(ctx, st("Бэклог"), st("В работе"))), "409 last status of category");
});

test("notifications: assignment, mentions, comments; never your own action; no duplicates", () => {
  const before = unreadCount(as(commenter));
  const it = createIssue(as(editor), { teamId: team.id, title: "Уведомления", assigneeId: commenter, description: `Посмотри [@ id="${viewer}" label="Виктор"]` });
  assert.equal(unreadCount(as(commenter)), before + 1);
  assert.equal(inbox(as(commenter)).items[0].kind, "assigned");
  assert.equal(inbox(as(viewer)).items[0].kind, "mentioned");
  assert.equal(inbox(as(editor)).items.filter((n) => n.issue?.id === it.id).length, 0, "the actor is not notified");
  // Two comments: the commenter (assignee, subscribed) gets one "comment" row, refreshed.
  addComment(as(editor), it.id, { body: "Первый" });
  addComment(as(editor), it.id, { body: "Второй" });
  const rows = inbox(as(commenter)).items.filter((n) => n.issue?.id === it.id && n.kind === "comment");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].excerpt, "Второй");
  // A mention in a comment notifies as "mentioned", not also "comment".
  const c = addComment(as(commenter), it.id, { body: `[@ id="${owner}" label="Ольга"] глянь` });
  const ownerRows = inbox(as(owner)).items.filter((n) => n.issue?.id === it.id);
  assert.deepEqual(
    ownerRows.map((n) => n.kind),
    ["mentioned"]
  );
  // Editing the comment does not notify again for the same mention.
  markNotifications(as(owner), "all", "read");
  editComment(as(commenter), c.id, { body: `[@ id="${owner}" label="Ольга"] глянь ещё` });
  assert.equal(unreadCount(as(owner)), 0);
  // Mentions of someone outside the workspace do nothing.
  addComment(as(editor), it.id, { body: `[@ id="${stranger}" label="Чужой"]` });
  assert.equal(sql("SELECT COUNT(*) AS n FROM pj_notifications WHERE user_id = ?").get(stranger)?.n, 0);
  // Read, archive.
  const n = inbox(as(commenter)).items[0];
  markNotifications(as(commenter), [n.id], "archive");
  assert.ok(!inbox(as(commenter)).items.some((x) => x.id === n.id));
  assert.ok(inbox(as(commenter), { archived: true }).items.some((x) => x.id === n.id));
  // Someone else's notification ids change nothing.
  assert.equal(markNotifications(as(viewer), [n.id], "unarchive"), 0);
});

test("attachments: members of the issue's workspace only; signed links expire", () => {
  const it = createIssue(as(editor), { teamId: team.id, title: "Скриншот" });
  const a = addAttachment(as(editor), it.id, { name: "screen.png", stored: `${"a".repeat(40)}.png`, bytes: 10, payer: owner });
  assert.ok(attachmentFor(as(viewer), a.id));
  assert.equal(attachmentFor(as(stranger, otherWs), a.id), null);
  assert.equal(code(() => addAttachment(as(viewer), it.id, { name: "x.png", stored: `${"b".repeat(40)}.png`, bytes: 1, payer: owner })), "403 forbidden");
  const link = signedLink(as(viewer), a.id);
  const u = new URL(link.url, "http://x");
  assert.ok(checkSignedLink(a.id, u.searchParams.get("exp"), u.searchParams.get("sig")));
  assert.ok(!checkSignedLink(a.id, u.searchParams.get("exp"), `${u.searchParams.get("sig")}x`));
  assert.ok(!checkSignedLink("other", u.searchParams.get("exp"), u.searchParams.get("sig")));
  assert.ok(!checkSignedLink(a.id, u.searchParams.get("exp"), u.searchParams.get("sig"), Date.now() + 16 * 60_000));
  assert.equal(issueDetail(as(viewer), it.id).attachmentList[0].url, `/api/projects/attachments/${a.id}`);
});

test("saved views: personal for anyone, shared by editors", () => {
  const mineV = saveView(as(viewer), null, { name: "Мои срочные", filters: { assignee: ["me"], priority: [1] }, display: { layout: "board" } });
  assert.equal(mineV.shared, false);
  assert.equal(code(() => saveView(as(viewer), null, { name: "Для всех", shared: true })), "403 forbidden");
  const shared = saveView(as(editor), null, { name: "Релиз", shared: true, filters: { category: ["started"] } });
  assert.ok(listViews(as(viewer)).some((v) => v.id === shared.id));
  assert.ok(!listViews(as(editor)).some((v) => v.id === mineV.id), "a personal view stays personal");
  assert.equal(code(() => saveView(as(commenter), shared.id, { name: "Чужое" })), "403 forbidden");
  const again = saveView(as(viewer), mineV.id, { name: "Мои срочные!" });
  assert.deepEqual(again.filters, { assignee: ["me"], priority: [1] });
});

test("cycles: dates, no overlaps, completion carries unfinished issues over", () => {
  const ctx = as(editor);
  const today = dayOf(Date.now());
  const c1 = createCycle(ctx, team.id, { startsOn: addDays(today, -7), endsOn: addDays(today, 6) });
  const c2 = createCycle(ctx, team.id, {});
  assert.equal(c2.startsOn, addDays(today, 7));
  assert.equal(code(() => createCycle(ctx, team.id, { startsOn: today, endsOn: addDays(today, 3) })), "409 cycles overlap");
  const done = createIssue(ctx, { teamId: team.id, title: "Сделано в цикле", cycleId: c1.id, estimate: 3 });
  const open = createIssue(ctx, { teamId: team.id, title: "Не успели", cycleId: c1.id, estimate: 5 });
  updateIssue(ctx, done.id, { statusId: st("Готово") });
  assert.equal(queryIssues(ctx, { filter: { cycle: ["current"] }, display: { group: "none" } }).total, 2);
  assert.equal(getCycle(ctx, c1.id).progress.completed, 1);
  const closed = completeCycle(ctx, c1.id, c2.id);
  assert.deepEqual(
    { scope: closed.summary?.scope, completed: closed.summary?.completed, carried: closed.summary?.carriedOver, points: closed.summary?.points, done: closed.summary?.pointsDone },
    { scope: 2, completed: 1, carried: 1, points: 8, done: 3 }
  );
  assert.equal(getIssueBrief(ctx, open.id).cycleId, c2.id);
  assert.equal(getIssueBrief(ctx, done.id).cycleId, c1.id);
  assert.equal(code(() => updateIssue(ctx, open.id, { cycleId: c1.id })), "400 bad request");
});

test("projects: progress, status updates, dependencies without loops", () => {
  const ctx = as(editor);
  const p1 = createProject(ctx, { name: "Запуск", teamIds: [team.id], leadId: editor, startDate: "2026-10-01", targetDate: "2026-12-01" });
  const p2 = createProject(ctx, { name: "Маркетинг", dependsOn: [p1.id] });
  assert.equal(code(() => updateProject(ctx, p1.id, { dependsOn: [p2.id] })), "409 dependency loop");
  assert.equal(code(() => createProject(ctx, { name: "Наоборот", startDate: "2026-12-01", targetDate: "2026-11-01" })), "400 bad request");
  createIssue(ctx, { teamId: team.id, title: "Лендинг", projectId: p1.id, statusId: st("Готово") });
  createIssue(ctx, { teamId: team.id, title: "Анонс", projectId: p1.id });
  createIssue(ctx, { teamId: team.id, title: "Отменили", projectId: p1.id, statusId: st("Отменено") });
  const p = getProject(ctx, p1.id);
  assert.deepEqual([p.progress.total, p.progress.completed], [2, 1]);
  addProjectUpdate(as(owner), p1.id, { health: "at_risk", body: "Сдвигаем анонс" });
  const after = getProject(ctx, p1.id);
  assert.equal(after.health, "at_risk");
  assert.equal(after.updates[0].body, "Сдвигаем анонс");
  assert.ok(inbox(as(editor)).items.some((n) => n.kind === "project_update" && n.projectId === p1.id), "the lead hears about the update");
  assert.equal(code(() => addProjectUpdate(as(commenter), p1.id, { health: "on_track", body: "x" })), "403 forbidden");
});

test("due reminders are sent once per issue and date", () => {
  const ctx = as(editor);
  const today = dayOf(Date.now());
  const it = createIssue(ctx, { teamId: team.id, title: "Срок завтра", assigneeId: editor, dueDate: addDays(today, 1) });
  const first = sendDueReminders();
  assert.ok(first >= 1);
  assert.equal(sendDueReminders(), 0);
  assert.ok(inbox(as(editor)).items.some((n) => n.kind === "due_soon" && n.issue?.id === it.id));
});

test("the assistant works from data, by rules", () => {
  const ctx = as(editor);
  const bugLabel = listStatuses(ctx) && (sql("SELECT id FROM pj_labels WHERE ws_id = ? AND name = 'Баг'").get(ws) as { id: string });
  const parsed = parseQuery(ctx, "мои срочные баги в работе");
  assert.deepEqual(parsed.filter.assignee, ["me"]);
  assert.deepEqual(parsed.filter.priority, [1]);
  assert.deepEqual(parsed.filter.category, ["started"]);
  assert.deepEqual(parsed.filter.label, [bugLabel.id]);
  assert.equal(parsed.filter.q, undefined);
  const p2 = parseQuery(ctx, "просроченные задачи без исполнителя про оплату");
  assert.equal(p2.filter.due, "overdue");
  assert.deepEqual(p2.filter.assignee, ["none"]);
  assert.equal(p2.filter.q, "про оплату");
  const t = triage(ctx, { title: "Падает вход через SSO", description: "Ошибка 500 при авторизации", teamId: team.id });
  assert.equal(t.priority, 2);
  assert.ok(t.labels.some((l) => l.id === bugLabel.id));
  const epic = createIssue(ctx, { teamId: team.id, title: "Онбординг", description: "План:\n- [ ] Экран приветствия\n- [x] Тексты\n1. Аналитика" });
  createIssue(ctx, { teamId: team.id, title: "Тексты", parentId: epic.id });
  assert.deepEqual(
    breakdown(ctx, epic.id).items.map((i) => i.title),
    ["Экран приветствия", "Аналитика"]
  );
  addComment(ctx, epic.id, { body: "Как назовём кнопку?" });
  addComment(as(owner), epic.id, { body: "Решили: «Начать». Нужно обновить макет." });
  const dg = digest(ctx, epic.id);
  assert.equal(dg.comments, 2);
  assert.equal(dg.decisions.length, 1);
  assert.equal(dg.questions.length, 0, "the question was answered by someone else");
  assert.equal(dg.actions.length, 1);
  const late = createIssue(ctx, { teamId: team.id, title: "Просрочено", dueDate: addDays(dayOf(Date.now()), -3) });
  assert.ok(stale(ctx).overdue.some((o) => o.id === late.id && o.days === 3));
  const proj = createProject(ctx, { name: "Релиз 2.0", teamIds: [team.id] });
  const x = createIssue(ctx, { teamId: team.id, title: "Миграция", projectId: proj.id });
  const y = createIssue(ctx, { teamId: team.id, title: "Выкладка", projectId: proj.id });
  addRelation(ctx, x.id, { type: "blocks", relatedId: y.id });
  const bl = blockers(ctx, { projectId: proj.id });
  assert.equal(bl.blocked[0].issue.id, y.id);
  assert.equal(bl.roots[0].id, x.id);
});

test("markdown helpers: mentions, new mentions only, plain text", () => {
  const md = `Привет [@ id="u1" label="Аня"] и [@ id="u2" label="Боря"]! **Важно**: [ссылка](https://x.com)`;
  assert.deepEqual(
    mentionsIn(md).map((m) => m.id),
    ["u1", "u2"]
  );
  assert.deepEqual(
    newMentions(`[@ id="u1" label="Аня"]`, md).map((m) => m.id),
    ["u2"]
  );
  assert.equal(plainText(md), "Привет @Аня и @Боря! Важно: ссылка");
});

test("bootstrap has what the app needs; deleting the workspace removes its tracker", () => {
  const ctx = as(viewer);
  const b = bootstrap(ctx, { personalName: "Личное" });
  assert.equal(b.ws.role, "viewer");
  assert.ok(b.teams.length >= 1 && b.statuses.length >= 7 && b.people.length >= 4);
  const tmp = createWorkspace(owner, "Временная").id;
  const tctx = ctxFor(owner, tmp, "edit");
  const tt = createTeam(tctx, { name: "Временная", key: "TMP" });
  const it = createIssue(tctx, { teamId: tt.id, title: "Исчезнет" });
  addComment(tctx, it.id, { body: "и это" });
  deleteWorkspace(owner, tmp);
  assert.equal(sql("SELECT COUNT(*) AS n FROM pj_issues WHERE ws_id = ?").get(tmp)?.n, 0);
  assert.equal(sql("SELECT COUNT(*) AS n FROM pj_comments WHERE ws_id = ?").get(tmp)?.n, 0);
  assert.equal(sql("SELECT COUNT(*) AS n FROM pj_teams WHERE ws_id = ?").get(tmp)?.n, 0);
  assert.equal(sql("SELECT COUNT(*) AS n FROM pj_issues_fts WHERE pj_issues_fts MATCH '\"Исчезнет\"'").get()?.n, 0);
});

test("the data export holds issues with comments, and a spreadsheet-safe CSV", () => {
  const ctx = as(editor);
  const it = createIssue(ctx, { teamId: team.id, title: "=HYPERLINK(\"http://x\")", assigneeId: editor });
  addComment(ctx, it.id, { body: "Комментарий для выгрузки" });
  const out = exportProjects(editor, ws);
  assert.ok(out);
  const data = JSON.parse(out.json) as { format: string; issues: { id: string; comments: { body: string }[] }[] };
  assert.equal(data.format, "zvena-projects/1");
  assert.equal(data.issues.find((i) => i.id === it.id)?.comments[0].body, "Комментарий для выгрузки");
  assert.ok(out.csv.includes(`"'=HYPERLINK(""http://x"")"`), "formulas are neutralised");
  assert.equal(exportProjects(stranger, ws), null, "nothing for someone outside the workspace");
  assert.ok(myOpenIssues(editor, ws, 200).some((i) => i.identifier === it.identifier));
  assert.deepEqual(myOpenIssues(stranger, ws), []);
});

test("security: a private team's project, sub-issues, blockers and history stay hidden from other editors", () => {
  const insider = ctxFor(editor, ws, "edit");
  const other = person("Второй редактор");
  acceptInvite(other, createInvite(owner, ws, "editor").token);
  const eve = ctxFor(other, ws, "edit");
  const hid = createTeam(insider, { name: "Скрытая", key: "HID", private: true });
  const secret = createProject(insider, { name: "Секретный план", teamIds: [hid.id] });
  // The project cannot be reached, linked to a visible team, used in a view or a dependency.
  assert.equal(code(() => getProject(eve, secret.id)), "404 project not found");
  assert.equal(code(() => createIssue(eve, { teamId: team.id, title: "Привязка", projectId: secret.id })), "400 bad request");
  assert.equal(code(() => saveView(eve, null, { name: "v", projectId: secret.id })), "404 project not found");
  const mine = createProject(eve, { name: "Открытый", teamIds: [team.id] });
  assert.equal(code(() => updateProject(eve, mine.id, { dependsOn: [secret.id] })), "400 bad request");
  updateProject(insider, mine.id, { dependsOn: [secret.id] });
  assert.deepEqual(getProject(eve, mine.id).dependsOn, [], "a hidden dependency is not shown");
  assert.equal(parseQuery(eve, "секретный план").filter.project, undefined, "the phrase parser does not reveal hidden projects");
  // Sub-issues and blockers of the private team do not leak through a public issue.
  const pub = createIssue(eve, { teamId: team.id, title: "Публичная родительская" });
  createIssue(insider, { teamId: hid.id, title: "Тайная подзадача", parentId: pub.id });
  const blocker = createIssue(insider, { teamId: hid.id, title: "Тайный блокер" });
  addRelation(insider, pub.id, { type: "blocked_by", relatedId: blocker.id });
  assert.ok(!breakdown(eve, pub.id).existing.includes("Тайная подзадача"));
  assert.ok(!queryIssues(eve, { filter: { blocked: true }, display: { group: "none" }, limit: 200 }).groups.flatMap((g) => g.items).some((i) => i.id === pub.id));
  const history = issueDetail(eve, pub.id).activity.filter((a) => a.kind === "relation");
  assert.equal(history.length, 1);
  assert.deepEqual(history[0].to, { type: "blocked_by", issue: null, identifier: null }, "the hidden issue is blanked in the history");
  assert.equal((issueDetail(insider, pub.id).activity.find((a) => a.kind === "relation")?.to as { identifier: string }).identifier, blocker.identifier);
  // No probing of hidden ids through favorites or board positions.
  assert.equal(code(() => setFavorite(eve, "issue", blocker.id, true)), "404 not found");
  assert.equal(code(() => setFavorite(eve, "project", secret.id, true)), "404 not found");
  assert.equal(code(() => updateIssue(eve, pub.id, { position: { before: blocker.id, after: null } })), "400 bad request");
});

test("security: hostile markdown runs in linear time", () => {
  const inputs = ["<".repeat(100_000), "[@ ".repeat(40_000), `[@ ${" ".repeat(100_000)}`, "[x](".repeat(30_000), `[@ ${"a".repeat(100_000)}]`, "![".repeat(50_000), "[".repeat(100_000)];
  for (const s of inputs) {
    const t = Date.now();
    plainText(s, 4000);
    mentionsIn(s);
    newMentions(s, s);
    assert.ok(Date.now() - t < 250, `slow on ${JSON.stringify(s.slice(0, 6))}…: ${Date.now() - t} ms`);
  }
  const t = Date.now();
  triage(as(viewer), { title: "x", description: "<".repeat(20_000) });
  assert.ok(Date.now() - t < 250);
});

test("security: viewers do not subscribe; unknown notification actions are refused", () => {
  const it = createIssue(as(editor), { teamId: team.id, title: "Подписка" });
  assert.equal(code(() => setSubscribed(as(viewer), it.id, true)), "403 forbidden");
  assert.equal(code(() => setSubscribed(as(viewer), it.id, false)), "ok");
  assert.equal(code(() => markNotifications(as(viewer), "all", "constructor")), "400 bad request");
});

test("first run: My team with three examples in reading order; a second run changes nothing", () => {
  const fresh = createWorkspace(owner, "Студия Север").id;
  const ctx = ctxFor(owner, fresh, "edit");
  const first = startProjects(ctx, "ru");
  assert.equal(first.created, true);
  assert.equal(first.team.name, "Моя команда");
  assert.equal(first.team.key, "SS");
  const todo = queryIssues(ctxFor(owner, fresh, "read"), { filter: { category: ["unstarted"] }, display: { group: "none", order: "manual" } }).groups[0].items;
  assert.deepEqual(
    todo.map((i) => i.identifier),
    ["SS-1", "SS-2"]
  );
  const again = startProjects(ctxFor(owner, fresh, "edit"), "ru");
  assert.equal(again.created, false);
  assert.equal(listTeams(ctxFor(owner, fresh, "read")).length, 1);
  assert.equal(code(() => startProjects(ctxFor(viewer, ws, "read"), "ru")), "403 forbidden");
});

test("events: deleting a team announces every issue that goes with it", async () => {
  const { onChange } = await import("@/lib/projects/events");
  const ctx = as(owner);
  const doomed = createTeam(ctx, { name: "Временная команда", key: "TMPX" });
  const a = createIssue(ctx, { teamId: doomed.id, title: "Уйдёт 1" });
  const b = createIssue(ctx, { teamId: doomed.id, title: "Уйдёт 2" });
  const child = createIssue(ctx, { teamId: team.id, title: "Останется", parentId: a.id });
  const seen: { entity: string; id: string; deleted?: boolean }[] = [];
  const off = onChange((c) => seen.push(c));
  deleteTeam(ctx, doomed.id);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  off();
  const deleted = seen.filter((c) => c.entity === "issue" && c.deleted).map((c) => c.id);
  assert.ok(deleted.includes(a.id) && deleted.includes(b.id));
  assert.ok(seen.some((c) => c.entity === "issue" && c.id === child.id && !c.deleted), "the sub-issue that lost its parent is announced");
  assert.equal(getIssueBrief(ctx, child.id).parentId, null);
});

test("the hot lookups use indexes: replies and notifications of a comment, comment authors, issues by id", async () => {
  const plan = (q: string, ...args: string[]) => (sql(`EXPLAIN QUERY PLAN ${q}`).all(...args) as { detail: string }[]).map((r) => r.detail).join(" | ");
  assert.match(plan("SELECT id FROM pj_comments WHERE parent_id = ?", "x"), /INDEX pj_comments_parent/);
  assert.match(plan("SELECT DISTINCT author_id FROM pj_comments WHERE ws_id = ? AND author_id IS NOT NULL", "x"), /INDEX pj_comments_ws_author/);
  assert.match(plan("SELECT id FROM pj_notifications WHERE comment_id = ?", "x"), /INDEX pj_notifications_comment/);
  const { issuesByIds } = await import("@/lib/projects/issues");
  const ctx = as(owner);
  const a = createIssue(ctx, { teamId: team.id, title: "По порядку 1" });
  const b = createIssue(ctx, { teamId: team.id, title: "По порядку 2" });
  assert.deepEqual(
    issuesByIds(ctx, [b.id, "nope", a.id, b.id]).map((i) => i.id),
    [b.id, a.id, b.id]
  );
});

test("the first board speaks the language of the person who opened it", async () => {
  const { seedFor } = await import("@/lib/projects/seed");
  for (const [locale, todo] of [
    ["zh", "待处理"],
    ["es", "Por hacer"],
    ["ar", "للتنفيذ"],
  ] as const) {
    // Personal workspaces are not limited: a new person per language.
    const who = signInWith({ provider: "dev", subject: `pj-seed-${locale}`, name: `Seed ${locale}` }, "2026-10-13");
    assert.ok(who.ok);
    const me = who.ok ? who.user.id : "";
    const w = createWorkspace(me, `Seed ${locale}`).id;
    const r = startProjects(ctxFor(me, w, "edit"), locale);
    assert.equal(r.team.name, seedFor(locale).team);
    const st = listStatuses(ctxFor(me, w, "read")).filter((s) => s.teamId === r.team.id);
    assert.ok(st.some((s) => s.name === todo && s.category === "unstarted"));
    const first = queryIssues(ctxFor(me, w, "read"), { filter: {}, display: { group: "none", order: "manual" } }).groups[0].items;
    assert.equal(first.length, 3);
    assert.ok(first.some((i) => i.title === seedFor(locale).examples[0].title));
  }
  assert.equal(seedFor("xx").team, "My team", "an unknown language falls back to English");
});
