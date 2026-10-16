// The words Projects writes on the server (Jev's drafts: issue templates,
// project updates, cycle summaries), in English and Russian. The other
// languages come from src/i18n/catalogs/projects/ (keys "jev.*"). Plain data:
// safe to import anywhere, unlike components/projects/i18n.ts.

import { msg } from "@/i18n/runtime";

export const en = {
  "jev.bug.happens": "What happens",
  "jev.bug.steps": "Steps to reproduce",
  "jev.bug.expected": "Expected behaviour",
  "jev.bug.env": "Environment",
  "jev.bug.device": "Browser / device",
  "jev.bug.gone": "The bug no longer reproduces",
  "jev.bug.test": "A test covers it",
  "jev.task.context": "Context",
  "jev.task.goal": "Goal",
  "jev.task.tasks": "Tasks",
  "jev.task.outOfScope": "Out of scope",
  "jev.doneWhen": "Done when",
  "jev.upd.progress": "**Progress:** {pct}% ({done} of {total} issues).",
  "jev.upd.target": "**Target date:** {date}.",
  "jev.upd.doneWeek": "Done this week",
  "jev.upd.noneWeek": "No issues completed this week.",
  "jev.upd.inProgress": "In progress",
  "jev.upd.blocked": "Blocked",
  "jev.upd.overdue": "Overdue",
  "jev.cyc.head": "Cycle {n}: {from} — {to}, day {passed} of {days}.",
  "jev.cyc.headNamed": "Cycle {n} “{name}”: {from} — {to}, day {passed} of {days}.",
  "jev.cyc.done": "Done {done} of {total} issues ({pct}%), {started} in progress.",
  "jev.cyc.points": "Estimates: {done} of {total} points.",
  "jev.cyc.added": "Issues added after the start: {n}.",
  "jev.cyc.completed": "Completed: {carried} carried over, {canceled} canceled.",
  "jev.cyc.behind": "Behind pace: at this rate some issues will carry over.",
};

export type ProjKey = keyof typeof en;

const ru: Record<ProjKey, string> = {
  "jev.bug.happens": "Что происходит",
  "jev.bug.steps": "Как воспроизвести",
  "jev.bug.expected": "Ожидаемое поведение",
  "jev.bug.env": "Окружение",
  "jev.bug.device": "Браузер / устройство",
  "jev.bug.gone": "Ошибка не воспроизводится",
  "jev.bug.test": "Добавлен тест",
  "jev.task.context": "Контекст",
  "jev.task.goal": "Цель",
  "jev.task.tasks": "Что сделать",
  "jev.task.outOfScope": "Вне рамок",
  "jev.doneWhen": "Критерии готовности",
  "jev.upd.progress": "**Прогресс:** {pct}% ({done} из {total} задач).",
  "jev.upd.target": "**Целевая дата:** {date}.",
  "jev.upd.doneWeek": "Сделано за неделю",
  "jev.upd.noneWeek": "За неделю задач не завершено.",
  "jev.upd.inProgress": "В работе",
  "jev.upd.blocked": "Заблокировано",
  "jev.upd.overdue": "Просрочено",
  "jev.cyc.head": "Цикл {n}: {from} — {to}, прошло {passed} из {days} дн.",
  "jev.cyc.headNamed": "Цикл {n} «{name}»: {from} — {to}, прошло {passed} из {days} дн.",
  "jev.cyc.done": "Готово {done} из {total} задач ({pct}%), в работе {started}.",
  "jev.cyc.points": "Оценка: {done} из {total} очков.",
  "jev.cyc.added": "После старта добавлено задач: {n}.",
  "jev.cyc.completed": "Цикл завершён: перенесено {carried}, отменено {canceled}.",
  "jev.cyc.behind": "Темп ниже плана: при текущей скорости часть задач перейдёт в следующий цикл.",
};

export function projText(locale: string, key: ProjKey, vars?: Record<string, string | number>): string {
  let s = locale === "ru" ? ru[key] : ((locale === "en" ? undefined : msg("projects", locale, key)) ?? en[key]);
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
