// The words Projects writes on the server (the assistant's drafts: issue templates,
// project updates, cycle summaries), in English and Russian. The other
// languages come from src/i18n/catalogs/projects/ (keys "draft.*"). Plain data:
// safe to import anywhere, unlike components/projects/i18n.ts.

import { msg } from "@/i18n/runtime";

export const en = {
  "draft.bug.happens": "What happens",
  "draft.bug.steps": "Steps to reproduce",
  "draft.bug.expected": "Expected behaviour",
  "draft.bug.env": "Environment",
  "draft.bug.device": "Browser / device",
  "draft.bug.gone": "The bug no longer reproduces",
  "draft.bug.test": "A test covers it",
  "draft.task.context": "Context",
  "draft.task.goal": "Goal",
  "draft.task.tasks": "Tasks",
  "draft.task.outOfScope": "Out of scope",
  "draft.doneWhen": "Done when",
  "draft.upd.progress": "**Progress:** {pct}% ({done} of {total} issues).",
  "draft.upd.target": "**Target date:** {date}.",
  "draft.upd.doneWeek": "Done this week",
  "draft.upd.noneWeek": "No issues completed this week.",
  "draft.upd.inProgress": "In progress",
  "draft.upd.blocked": "Blocked",
  "draft.upd.overdue": "Overdue",
  "draft.cyc.head": "Cycle {n}: {from} — {to}, day {passed} of {days}.",
  "draft.cyc.headNamed": "Cycle {n} “{name}”: {from} — {to}, day {passed} of {days}.",
  "draft.cyc.done": "Done {done} of {total} issues ({pct}%), {started} in progress.",
  "draft.cyc.points": "Estimates: {done} of {total} points.",
  "draft.cyc.added": "Issues added after the start: {n}.",
  "draft.cyc.completed": "Completed: {carried} carried over, {canceled} canceled.",
  "draft.cyc.behind": "Behind pace: at this rate some issues will carry over.",
};

export type ProjKey = keyof typeof en;

const ru: Record<ProjKey, string> = {
  "draft.bug.happens": "Что происходит",
  "draft.bug.steps": "Как воспроизвести",
  "draft.bug.expected": "Ожидаемое поведение",
  "draft.bug.env": "Окружение",
  "draft.bug.device": "Браузер / устройство",
  "draft.bug.gone": "Ошибка не воспроизводится",
  "draft.bug.test": "Добавлен тест",
  "draft.task.context": "Контекст",
  "draft.task.goal": "Цель",
  "draft.task.tasks": "Что сделать",
  "draft.task.outOfScope": "Вне рамок",
  "draft.doneWhen": "Критерии готовности",
  "draft.upd.progress": "**Прогресс:** {pct}% ({done} из {total} задач).",
  "draft.upd.target": "**Целевая дата:** {date}.",
  "draft.upd.doneWeek": "Сделано за неделю",
  "draft.upd.noneWeek": "За неделю задач не завершено.",
  "draft.upd.inProgress": "В работе",
  "draft.upd.blocked": "Заблокировано",
  "draft.upd.overdue": "Просрочено",
  "draft.cyc.head": "Цикл {n}: {from} — {to}, прошло {passed} из {days} дн.",
  "draft.cyc.headNamed": "Цикл {n} «{name}»: {from} — {to}, прошло {passed} из {days} дн.",
  "draft.cyc.done": "Готово {done} из {total} задач ({pct}%), в работе {started}.",
  "draft.cyc.points": "Оценка: {done} из {total} очков.",
  "draft.cyc.added": "После старта добавлено задач: {n}.",
  "draft.cyc.completed": "Цикл завершён: перенесено {carried}, отменено {canceled}.",
  "draft.cyc.behind": "Темп ниже плана: при текущей скорости часть задач перейдёт в следующий цикл.",
};

export function projText(locale: string, key: ProjKey, vars?: Record<string, string | number>): string {
  let s = locale === "ru" ? ru[key] : ((locale === "en" ? undefined : msg("projects", locale, key)) ?? en[key]);
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
