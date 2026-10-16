// zvena Documents templates (Notion's gallery staples), written in English and
// Russian; the other languages come from the Docs catalogs ("tplc:<English>").
// A template is a tree: a page or a database (with rows), plus sub-pages.

import { blankNote, defaultView, shortId } from "@/lib/notes/model";
import type { NotesStore } from "@/lib/notes/store";
import { intlOf } from "@/i18n/locales";
import { msg } from "@/i18n/runtime";
import type { DbProperty, DbSchema, Note, NoteColor, PropValue, SelectOption } from "@/lib/notes/types";

type B = Record<string, unknown>;

/** A template's words in the language: Russian and English are here, the others are the catalogs' translation of the English. */
const tx = (lang: string, en: string, ru: string): string => (lang === "ru" ? ru : lang === "en" ? en : (msg("docs", lang, `tplc:${en}`) ?? en));

const p = (text: string | B[] = ""): B => ({ type: "paragraph", content: text });
const h1 = (text: string): B => ({ type: "heading", props: { level: 1 }, content: text });
const h2 = (text: string): B => ({ type: "heading", props: { level: 2 }, content: text });
const h3 = (text: string): B => ({ type: "heading", props: { level: 3 }, content: text });
const todo = (text: string, checked = false): B => ({ type: "checkListItem", props: { checked }, content: text });
const bullet = (text: string | B[], children?: B[]): B => ({ type: "bulletListItem", content: text, ...(children ? { children } : {}) });
const num = (text: string): B => ({ type: "numberedListItem", content: text });
const toggle = (text: string, children: B[]): B => ({ type: "toggleListItem", content: text, children });
const callout = (icon: string, text: string | B[], color: NoteColor = "default"): B => ({ type: "callout", props: { icon, color }, content: text });
const quote = (text: string): B => ({ type: "quote", content: text });
const divider = (): B => ({ type: "divider" });
const code = (language: string, text: string): B => ({ type: "codeBlock", props: { language }, content: text });
const bold = (text: string): B => ({ type: "text", text, styles: { bold: true } });
const plain = (text: string): B => ({ type: "text", text, styles: {} });
const codeText = (text: string): B => ({ type: "text", text, styles: { code: true } });
/** A date mention (shows "Today", "15 October"…). */
const dateRef = (ymd: string): B => ({ type: "mention", props: { noteId: "", date: ymd } });

export interface TplRow {
  title: string;
  icon?: string;
  values: Record<string, PropValue | { option: string } | { options: string[] } | undefined>;
  content?: B[];
}

export interface TplNode {
  kind: "page" | "database";
  title: string;
  icon: string;
  cover?: string;
  content?: B[];
  /** Databases: property specs by key; option names resolve to ids. */
  props?: { key: string; name: string; type: DbProperty["type"]; options?: { name: string; color: NoteColor; group?: SelectOption["group"] }[] }[];
  views?: { type: "table" | "board" | "list" | "gallery" | "calendar" | "timeline" | "chart"; name: string; groupBy?: string; dateProp?: string }[];
  rows?: TplRow[];
  children?: TplNode[];
  /** Child placement in the parent's body: a link block (page) or inline database. */
  inline?: boolean;
}

export interface Template {
  key: string;
  icon: string;
  /** Gallery section (Notion groups its gallery the same way). */
  category: "start" | "team" | "school" | "work" | "life";
  /** The template in an interface language ("en", "ru", "es"…). */
  build: (lang: string) => TplNode;
}

export const TEMPLATE_CATEGORIES: Template["category"][] = ["start", "team", "school", "work", "life"];

const col = (width: number, children: B[]): B => ({ type: "column", props: { width }, children });
const columns = (...cols: B[]): B => ({ type: "columnList", children: cols });

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

export const TEMPLATES: Template[] = [
  {
    key: "getStarted",
    category: "start",
    icon: "👋",
    build: (lang) => ({
      kind: "page",
      title: tx(lang, "Getting Started", "Начало работы"),
      icon: "👋",
      content: [
        p(tx(lang, "Welcome to zvena Docs! This is your team's space for notes, tasks, docs and databases. Design is next door: put mockups right into pages.", "Добро пожаловать в Документы zvena! Это пространство команды для заметок, задач, документов и баз данных. Рядом — Дизайн: макеты можно вставлять прямо в страницы.")),
        h2(tx(lang, "The basics", "Основы")),
        todo(tx(lang, "Click anywhere and just start typing", "Нажмите в любом месте и просто начните писать"), true),
        todo(tx(lang, "Hit / to see all the types of content you can add — headings, lists, tables, images and more", "Нажмите «/», чтобы увидеть все типы блоков: заголовки, списки, таблицы, изображения и многое другое")),
        todo(tx(lang, "Type /design to insert a frame from Design — its preview updates itself", "Наберите «/макет», чтобы вставить фрейм из Дизайна — превью обновляется само")),
        todo(tx(lang, "Highlight any text to style it, add a link or a comment", "Выделите текст, чтобы изменить стиль, добавить ссылку или комментарий")),
        todo(tx(lang, "On a computer, drag the ⋮⋮ handle on the left to reorder blocks", "На компьютере перетаскивайте блоки за ⋮⋮ слева, чтобы менять порядок")),
        todo(tx(lang, "Click + in the sidebar to add a new page", "Нажмите «+» в боковой панели, чтобы создать страницу")),
        todo(tx(lang, "Open Templates in the sidebar for ready-made trackers and planners", "Откройте «Шаблоны» в боковой панели — там готовые трекеры и планеры")),
        h2(tx(lang, "Try it out", "Попробуйте")),
        toggle(tx(lang, "This is a toggle — click the arrow", "Это раскрывающийся список — нажмите на стрелку"), [p(tx(lang, "You can hide any blocks inside, even other pages.", "Внутри можно прятать любые блоки, даже другие страницы."))]),
        callout("💡", [bold(tx(lang, "Tip: ", "Совет: ")), plain(tx(lang, "press Ctrl+K or Search in the sidebar to find any page.", "нажмите Ctrl+K или «Поиск» в боковой панели, чтобы найти любую страницу."))], "blue"),
        quote(tx(lang, "The best way to get started is to start.", "Лучший способ начать — начать.")),
        p([plain(tx(lang, "Inline code: ", "Встроенный код: ")), codeText(tx(lang, "const docs = 'together'", "const docs = 'вместе'"))]),
        divider(),
        p(tx(lang, "Below are a sub-page and a database. Open them to see how things work:", "Ниже — вложенная страница и база данных. Откройте их, чтобы посмотреть, как всё устроено:")),
      ],
      children: [
        {
          kind: "page",
          title: tx(lang, "Example sub-page", "Пример вложенной страницы"),
          icon: "📄",
          content: [
            p(tx(lang, "Pages can be nested inside each other, as deep as you like.", "Страницы можно вкладывать друг в друга без ограничений.")),
            h3(tx(lang, "What else a page can do", "Что ещё умеет страница")),
            bullet(tx(lang, "Cover and icon — hover the title", "Обложка и иконка — наведите на заголовок")),
            bullet(tx(lang, "Font style, small text and full width — the ••• menu at the top right", "Стиль шрифта, мелкий текст и широкий режим — меню «•••» справа вверху")),
            bullet(tx(lang, "Publish to the web — the Share button", "Публикация в интернете — кнопка «Поделиться»")),
          ],
        },
        {
          kind: "database",
          title: tx(lang, "My tasks", "Мои задачи"),
          icon: "✅",
          inline: true,
          props: [
            { key: "status", name: tx(lang, "Status", "Статус"), type: "status", options: [
              { name: tx(lang, "Not started", "Не начато"), color: "default", group: "todo" },
              { name: tx(lang, "In progress", "В работе"), color: "blue", group: "doing" },
              { name: tx(lang, "Done", "Готово"), color: "green", group: "done" },
            ] },
            { key: "due", name: tx(lang, "Due", "Срок"), type: "date" },
            { key: "prio", name: tx(lang, "Priority", "Приоритет"), type: "select", options: [
              { name: tx(lang, "High", "Высокий"), color: "red" },
              { name: tx(lang, "Medium", "Средний"), color: "yellow" },
              { name: tx(lang, "Low", "Низкий"), color: "gray" },
            ] },
          ],
          views: [
            { type: "board", name: tx(lang, "Board", "Доска"), groupBy: "status" },
            { type: "table", name: tx(lang, "Table", "Таблица") },
          ],
          rows: [
            { title: tx(lang, "Invite the team (Team → link)", "Пригласить команду (Команда → ссылка)"), values: { status: { option: tx(lang, "In progress", "В работе") }, prio: { option: tx(lang, "High", "Высокий") }, due: { start: day(0) } } },
            { title: tx(lang, "Create your first page", "Создать первую страницу"), values: { status: { option: tx(lang, "Not started", "Не начато") }, prio: { option: tx(lang, "Medium", "Средний") }, due: { start: day(1) } } },
            { title: tx(lang, "Move notes over from Notion (Import)", "Перенести заметки из Notion (Импорт)"), values: { status: { option: tx(lang, "Not started", "Не начато") }, prio: { option: tx(lang, "Low", "Низкий") }, due: { start: day(3) } } },
            { title: tx(lang, "Open Getting Started", "Открыть «Начало работы»"), values: { status: { option: tx(lang, "Done", "Готово") }, prio: { option: tx(lang, "Low", "Низкий") } } },
          ],
        },
      ],
    }),
  },
  {
    key: "homework",
    category: "school",
    icon: "📚",
    build: (lang) => ({
      kind: "database",
      title: tx(lang, "Homework", "Домашние задания"),
      icon: "📚",
      props: [
        { key: "subject", name: tx(lang, "Subject", "Предмет"), type: "select", options: [
          { name: tx(lang, "Math", "Математика"), color: "blue" },
          { name: tx(lang, "Language", "Русский язык"), color: "red" },
          { name: tx(lang, "Literature", "Литература"), color: "orange" },
          { name: tx(lang, "Physics", "Физика"), color: "purple" },
          { name: tx(lang, "Chemistry", "Химия"), color: "green" },
          { name: tx(lang, "Biology", "Биология"), color: "yellow" },
          { name: tx(lang, "History", "История"), color: "brown" },
          { name: tx(lang, "English", "Английский"), color: "pink" },
        ] },
        { key: "due", name: tx(lang, "Due", "Срок"), type: "date" },
        { key: "status", name: tx(lang, "Status", "Статус"), type: "status", options: [
          { name: tx(lang, "Not started", "Не начато"), color: "gray", group: "todo" },
          { name: tx(lang, "Doing", "Делаю"), color: "blue", group: "doing" },
          { name: tx(lang, "Turned in", "Сдано"), color: "green", group: "done" },
        ] },
        { key: "grade", name: tx(lang, "Grade", "Оценка"), type: "number" },
        { key: "notes", name: tx(lang, "Notes", "Заметки"), type: "text" },
      ],
      views: [
        { type: "board", name: tx(lang, "By status", "По статусу"), groupBy: "status" },
        { type: "calendar", name: tx(lang, "Calendar", "Календарь"), dateProp: "due" },
        { type: "table", name: tx(lang, "All assignments", "Все задания") },
      ],
      rows: [
        { title: tx(lang, "Exercises 112–115", "Упражнения 112–115"), icon: "✏️", values: { subject: { option: tx(lang, "Math", "Математика") }, due: { start: day(1) }, status: { option: tx(lang, "Not started", "Не начато") } } },
        { title: tx(lang, "Essay: my favourite character", "Сочинение «Мой любимый герой»"), icon: "📝", values: { subject: { option: tx(lang, "Literature", "Литература") }, due: { start: day(3) }, status: { option: tx(lang, "Doing", "Делаю") }, notes: tx(lang, "Outline done, writing next", "План готов, осталось написать") } },
        { title: tx(lang, "Lab: the pendulum", "Лабораторная: маятник"), icon: "🔬", values: { subject: { option: tx(lang, "Physics", "Физика") }, due: { start: day(5) }, status: { option: tx(lang, "Not started", "Не начато") } } },
        { title: tx(lang, "Vocabulary, Unit 4", "Слова, Unit 4"), icon: "🔤", values: { subject: { option: tx(lang, "English", "Английский") }, due: { start: day(-1) }, status: { option: tx(lang, "Turned in", "Сдано") }, grade: 5 } },
      ],
    }),
  },
  {
    key: "schedule",
    category: "school",
    icon: "🗓️",
    build: (lang) => {
      const days = [tx(lang, "Monday", "Понедельник"), tx(lang, "Tuesday", "Вторник"), tx(lang, "Wednesday", "Среда"), tx(lang, "Thursday", "Четверг"), tx(lang, "Friday", "Пятница")];
      const colors: NoteColor[] = ["blue", "green", "orange", "purple", "pink"];
      const lesson = (title: string, d: number, time: string, room: string, teacher: string, icon: string): TplRow => ({ title, icon, values: { day: { option: days[d] }, time, room, teacher } });
      return {
        kind: "database",
        title: tx(lang, "Class Schedule", "Расписание уроков"),
        icon: "🗓️",
        props: [
          { key: "day", name: tx(lang, "Day", "День"), type: "select", options: days.map((name, i) => ({ name, color: colors[i] })) },
          { key: "time", name: tx(lang, "Time", "Время"), type: "text" },
          { key: "room", name: tx(lang, "Room", "Кабинет"), type: "text" },
          { key: "teacher", name: tx(lang, "Teacher", "Учитель"), type: "text" },
        ],
        views: [
          { type: "board", name: tx(lang, "Week", "Неделя"), groupBy: "day" },
          { type: "table", name: tx(lang, "All classes", "Все уроки") },
        ],
        rows: [
          lesson(tx(lang, "Algebra", "Алгебра"), 0, "8:30", "214", tx(lang, "Ms. Ivanova", "Иванова А. П."), "➗"),
          lesson(tx(lang, "Literature", "Литература"), 0, "9:25", "301", tx(lang, "Mr. Smith", "Смирнов Д. С."), "📖"),
          lesson(tx(lang, "Physics", "Физика"), 1, "8:30", "105", tx(lang, "Mr. Cole", "Кузнецов И. В."), "⚛️"),
          lesson(tx(lang, "English", "Английский"), 1, "9:25", "220", tx(lang, "Ms. Parker", "Петрова Е. А."), "🇬🇧"),
          lesson(tx(lang, "Geometry", "Геометрия"), 2, "8:30", "214", tx(lang, "Ms. Ivanova", "Иванова А. П."), "📐"),
          lesson(tx(lang, "History", "История"), 2, "10:20", "312", tx(lang, "Mr. Owen", "Орлов П. Н."), "🏛️"),
          lesson(tx(lang, "Chemistry", "Химия"), 3, "9:25", "108", tx(lang, "Ms. Sokol", "Соколова М. И."), "🧪"),
          lesson(tx(lang, "Biology", "Биология"), 4, "8:30", "110", tx(lang, "Ms. Novak", "Новикова О. В."), "🌿"),
        ],
      };
    },
  },
  {
    key: "lecture",
    category: "school",
    icon: "🎓",
    build: (lang) => ({
      kind: "page",
      title: tx(lang, "Lecture Notes", "Конспект лекции"),
      icon: "🎓",
      content: [
        callout("💡", tx(lang, "The Cornell method: notes on the right during class, questions and key terms on the left afterwards, a summary in your own words at the bottom.", "Метод Корнелла: справа — конспект во время занятия, слева — вопросы и термины после него, внизу — итог своими словами."), "blue"),
        p([bold(tx(lang, "Course: ", "Предмет: ")), plain("—")]),
        p([bold(tx(lang, "Topic: ", "Тема: ")), plain("—")]),
        p([bold(tx(lang, "Date: ", "Дата: ")), dateRef(day(0))]),
        divider(),
        columns(
          col(1, [
            h3(tx(lang, "Cues", "Вопросы и термины")),
            bullet(tx(lang, "What is …?", "Что такое …?")),
            bullet(tx(lang, "Why …?", "Почему …?")),
            bullet(tx(lang, "Key terms", "Ключевые слова")),
          ]),
          col(2, [
            h3(tx(lang, "Notes", "Конспект")),
            bullet(tx(lang, "The main idea", "Главная мысль занятия")),
            bullet(tx(lang, "Facts and examples", "Факты и примеры"), [bullet("…")]),
            bullet(tx(lang, "Formulas and definitions", "Формулы и определения")),
          ])
        ),
        divider(),
        h3(tx(lang, "Summary", "Итог")),
        callout("📌", tx(lang, "In your own words: 3–5 sentences about what matters most.", "Своими словами: 3–5 предложений о самом главном."), "yellow"),
        toggle(tx(lang, "Check yourself", "Проверь себя"), [todo(tx(lang, "I can explain it without my notes", "Могу объяснить тему без конспекта")), todo(tx(lang, "I solved an example on my own", "Решил(а) пример сам(а)"))]),
      ],
    }),
  },
  {
    key: "exam",
    category: "school",
    icon: "🎯",
    build: (lang) => ({
      kind: "page",
      title: tx(lang, "Exam Prep", "Подготовка к экзамену"),
      icon: "🎯",
      content: [
        callout("🎯", [bold(tx(lang, "Exam: ", "Экзамен: ")), dateRef(day(21)), plain(tx(lang, ". Review 2–3 topics a day and mark your confidence honestly.", ". Повторяйте 2–3 темы в день и честно отмечайте уверенность."))], "red"),
        h2(tx(lang, "Plan", "План")),
        todo(tx(lang, "List every topic", "Собрать все темы и билеты")),
        todo(tx(lang, "Go through each topic once", "Пройти каждую тему хотя бы раз")),
        todo(tx(lang, "Take a practice test", "Решить пробный вариант")),
        todo(tx(lang, "Review the weak topics", "Повторить слабые темы")),
        h2(tx(lang, "Topics", "Темы")),
      ],
      children: [
        {
          kind: "database",
          inline: true,
          title: tx(lang, "Topics", "Темы"),
          icon: "",
          props: [
            { key: "status", name: tx(lang, "Status", "Статус"), type: "status", options: [
              { name: tx(lang, "Not started", "Не начато"), color: "gray", group: "todo" },
              { name: tx(lang, "Reviewing", "Повторяю"), color: "yellow", group: "doing" },
              { name: tx(lang, "Know it", "Знаю"), color: "green", group: "done" },
            ] },
            { key: "conf", name: tx(lang, "Confidence", "Уверенность"), type: "select", options: [
              { name: tx(lang, "Low", "Слабо"), color: "red" },
              { name: tx(lang, "Medium", "Средне"), color: "yellow" },
              { name: tx(lang, "High", "Уверенно"), color: "green" },
            ] },
            { key: "next", name: tx(lang, "Review on", "Повторить"), type: "date" },
            { key: "notes", name: tx(lang, "Notes", "Заметки"), type: "text" },
          ],
          views: [
            { type: "table", name: tx(lang, "Table", "Таблица") },
            { type: "board", name: tx(lang, "By status", "По статусу"), groupBy: "status" },
          ],
          rows: [
            { title: tx(lang, "Topic 1. Key definitions", "Тема 1. Определения и основные понятия"), values: { status: { option: tx(lang, "Know it", "Знаю") }, conf: { option: tx(lang, "High", "Уверенно") }, next: { start: day(7) } } },
            { title: tx(lang, "Topic 2. Formulas and problems", "Тема 2. Формулы и задачи"), values: { status: { option: tx(lang, "Reviewing", "Повторяю") }, conf: { option: tx(lang, "Medium", "Средне") }, next: { start: day(2) } } },
            { title: tx(lang, "Topic 3. Dates and events", "Тема 3. Даты и события"), values: { status: { option: tx(lang, "Not started", "Не начато") }, conf: { option: tx(lang, "Low", "Слабо") }, next: { start: day(1) } } },
          ],
        },
      ],
    }),
  },
  {
    key: "essay",
    category: "school",
    icon: "✍️",
    build: (lang) => ({
      kind: "page",
      title: tx(lang, "Essay Planner", "План эссе"),
      icon: "✍️",
      content: [
        h2(tx(lang, "Topic and question", "Тема и вопрос")),
        p(tx(lang, "What question does the essay answer?", "На какой вопрос отвечает эссе?")),
        h2(tx(lang, "Thesis", "Тезис")),
        callout("💬", tx(lang, "One sentence: the main claim you will defend.", "Одно предложение — главная мысль, которую вы доказываете."), "purple"),
        h2(tx(lang, "Outline", "План")),
        num(tx(lang, "Introduction: context and thesis", "Введение: контекст и тезис")),
        num(tx(lang, "Argument 1 + example", "Аргумент 1 + пример")),
        num(tx(lang, "Argument 2 + example", "Аргумент 2 + пример")),
        num(tx(lang, "Counterargument and reply", "Контраргумент и ответ на него")),
        num(tx(lang, "Conclusion: back to the thesis", "Заключение: вывод и связь с тезисом")),
        h2(tx(lang, "Sources", "Источники")),
        bullet(tx(lang, "Author, Title, year — what to use", "Автор, «Название», год — что взять оттуда")),
        h2(tx(lang, "Draft", "Черновик")),
        p(""),
      ],
    }),
  },
  {
    key: "todo",
    category: "life",
    icon: "☑️",
    build: (lang) => ({
      kind: "page",
      title: tx(lang, "To-do List", "Список дел"),
      icon: "☑️",
      content: [
        h2(tx(lang, "Today", "Сегодня")),
        todo(tx(lang, "Reply to emails", "Ответить на письма")),
        todo(tx(lang, "Team call at 11:00", "Созвон с командой в 11:00")),
        todo(tx(lang, "Buy groceries", "Купить продукты")),
        h2(tx(lang, "This week", "На этой неделе")),
        todo(tx(lang, "Prepare the report", "Подготовить отчёт")),
        todo(tx(lang, "Book a doctor's appointment", "Записаться к врачу")),
        h2(tx(lang, "Someday", "Когда-нибудь")),
        todo(tx(lang, "Read “The Master and Margarita”", "Прочитать «Мастер и Маргарита»")),
        todo(tx(lang, "Learn 100 Spanish words", "Выучить 100 испанских слов")),
      ],
    }),
  },
  {
    key: "meeting",
    category: "work",
    icon: "🗓️",
    build: (lang) => ({
      kind: "database",
      title: tx(lang, "Meeting Notes", "Заметки встреч"),
      icon: "🗓️",
      props: [
        { key: "date", name: tx(lang, "Date", "Дата"), type: "date" },
        { key: "type", name: tx(lang, "Type", "Тип"), type: "select", options: [
          { name: tx(lang, "Planning", "Планирование"), color: "blue" },
          { name: tx(lang, "Standup", "Стендап"), color: "green" },
          { name: tx(lang, "Retro", "Ретро"), color: "purple" },
          { name: tx(lang, "1:1", "Встреча 1:1"), color: "orange" },
        ] },
        { key: "people", name: tx(lang, "Attendees", "Участники"), type: "text" },
        { key: "summary", name: tx(lang, "Outcome", "Итоги"), type: "text" },
      ],
      views: [
        { type: "table", name: tx(lang, "All meetings", "Все встречи") },
        { type: "calendar", name: tx(lang, "Calendar", "Календарь"), dateProp: "date" },
      ],
      rows: [
        {
          title: tx(lang, "Sprint planning", "Планирование спринта"),
          icon: "🎯",
          values: { date: { start: day(-1) }, type: { option: tx(lang, "Planning", "Планирование") }, people: tx(lang, "Ana, Ben, Vic", "Аня, Борис, Вика") },
          content: [
            h2(tx(lang, "Agenda", "Повестка")),
            num(tx(lang, "Last sprint results", "Итоги прошлого спринта")),
            num(tx(lang, "Goals for this sprint", "Цели на этот спринт")),
            h2(tx(lang, "Notes", "Заметки")),
            bullet(tx(lang, "Team velocity is up 15%", "Скорость команды выросла на 15%")),
            bullet(tx(lang, "Main risk: payment integration", "Главный риск — интеграция с оплатой")),
            h2(tx(lang, "Action items", "Задачи")),
            todo(tx(lang, "Ben: payment prototype by Friday", "Борис: прототип оплаты к пятнице")),
            todo(tx(lang, "Vic: update the roadmap", "Вика: обновить дорожную карту")),
          ],
        },
        {
          title: tx(lang, "Daily standup", "Ежедневный стендап"),
          icon: "☕",
          values: { date: { start: day(0) }, type: { option: tx(lang, "Standup", "Стендап") }, people: tx(lang, "Whole team", "Вся команда") },
          content: [h2(tx(lang, "Yesterday", "Вчера")), bullet(""), h2(tx(lang, "Today", "Сегодня")), bullet(""), h2(tx(lang, "Blockers", "Блокеры")), bullet("")],
        },
      ],
    }),
  },
  {
    key: "journal",
    category: "life",
    icon: "📔",
    build: (lang) => ({
      kind: "database",
      title: tx(lang, "Journal", "Дневник"),
      icon: "📔",
      props: [
        { key: "date", name: tx(lang, "Date", "Дата"), type: "date" },
        { key: "mood", name: tx(lang, "Mood", "Настроение"), type: "select", options: [
          { name: "😄", color: "green" },
          { name: "🙂", color: "blue" },
          { name: "😐", color: "gray" },
          { name: "😔", color: "purple" },
        ] },
        { key: "tags", name: tx(lang, "Tags", "Теги"), type: "multi_select", options: [
          { name: tx(lang, "Work", "Работа"), color: "blue" },
          { name: tx(lang, "Family", "Семья"), color: "pink" },
          { name: tx(lang, "Health", "Здоровье"), color: "green" },
        ] },
      ],
      views: [
        { type: "list", name: tx(lang, "Entries", "Записи") },
        { type: "calendar", name: tx(lang, "Calendar", "Календарь"), dateProp: "date" },
      ],
      rows: [
        {
          title: tx(lang, "A good day", "Хороший день"),
          icon: "🌤️",
          values: { date: { start: day(0) }, mood: { option: "😄" }, tags: { options: [tx(lang, "Work", "Работа")] } },
          content: [h3(tx(lang, "What went well", "Что получилось")), p(""), h3(tx(lang, "Grateful for", "За что я благодарен")), p(""), h3(tx(lang, "To improve tomorrow", "Что улучшить завтра")), p("")],
        },
      ],
    }),
  },
  {
    key: "projects",
    category: "work",
    icon: "🚀",
    build: (lang) => ({
      kind: "database",
      title: tx(lang, "Projects", "Проекты"),
      icon: "🚀",
      props: [
        { key: "status", name: tx(lang, "Status", "Статус"), type: "status", options: [
          { name: tx(lang, "Idea", "Идея"), color: "gray", group: "todo" },
          { name: tx(lang, "In progress", "В работе"), color: "blue", group: "doing" },
          { name: tx(lang, "In review", "На проверке"), color: "purple", group: "doing" },
          { name: tx(lang, "Done", "Готово"), color: "green", group: "done" },
        ] },
        { key: "prio", name: tx(lang, "Priority", "Приоритет"), type: "select", options: [
          { name: "P0", color: "red" },
          { name: "P1", color: "orange" },
          { name: "P2", color: "gray" },
        ] },
        { key: "owner", name: tx(lang, "Owner", "Ответственный"), type: "text" },
        { key: "due", name: tx(lang, "Due", "Срок"), type: "date" },
        { key: "progress", name: tx(lang, "Progress", "Прогресс"), type: "number" },
      ],
      views: [
        { type: "board", name: tx(lang, "By status", "По статусу"), groupBy: "status" },
        { type: "table", name: tx(lang, "All projects", "Все проекты") },
        { type: "calendar", name: tx(lang, "Deadlines", "Сроки"), dateProp: "due" },
        { type: "timeline", name: tx(lang, "Timeline", "Хронология"), dateProp: "due" },
        { type: "chart", name: tx(lang, "Chart", "Диаграмма") },
      ],
      rows: [
        { title: tx(lang, "Website redesign", "Новый сайт"), icon: "🎨", values: { status: { option: tx(lang, "In progress", "В работе") }, prio: { option: "P0" }, owner: tx(lang, "Ana", "Аня"), due: { start: day(-6), end: day(7) }, progress: 60 } },
        { title: tx(lang, "Mobile app", "Мобильное приложение"), icon: "📱", values: { status: { option: tx(lang, "Idea", "Идея") }, prio: { option: "P1" }, owner: tx(lang, "Ben", "Борис"), due: { start: day(10), end: day(30) }, progress: 0 } },
        { title: tx(lang, "Customer newsletter", "Рассылка для клиентов"), icon: "✉️", values: { status: { option: tx(lang, "In review", "На проверке") }, prio: { option: "P2" }, owner: tx(lang, "Vic", "Вика"), due: { start: day(-4), end: day(2) }, progress: 90 } },
        { title: tx(lang, "US launch", "Запуск в США"), icon: "🇺🇸", values: { status: { option: tx(lang, "Done", "Готово") }, prio: { option: "P0" }, owner: tx(lang, "Team", "Команда"), progress: 100 } },
      ],
    }),
  },
  {
    key: "reading",
    category: "life",
    icon: "📚",
    build: (lang) => ({
      kind: "database",
      title: tx(lang, "Reading List", "Список чтения"),
      icon: "📚",
      props: [
        { key: "author", name: tx(lang, "Author", "Автор"), type: "text" },
        { key: "kind", name: tx(lang, "Type", "Тип"), type: "select", options: [
          { name: tx(lang, "Book", "Книга"), color: "brown" },
          { name: tx(lang, "Article", "Статья"), color: "blue" },
          { name: tx(lang, "Podcast", "Подкаст"), color: "purple" },
        ] },
        { key: "status", name: tx(lang, "Status", "Статус"), type: "status", options: [
          { name: tx(lang, "Want to read", "Хочу прочитать"), color: "gray", group: "todo" },
          { name: tx(lang, "Reading", "Читаю"), color: "blue", group: "doing" },
          { name: tx(lang, "Finished", "Прочитано"), color: "green", group: "done" },
        ] },
        { key: "rating", name: tx(lang, "Rating", "Оценка"), type: "select", options: [
          { name: "⭐⭐⭐⭐⭐", color: "yellow" },
          { name: "⭐⭐⭐⭐", color: "yellow" },
          { name: "⭐⭐⭐", color: "yellow" },
        ] },
        { key: "link", name: tx(lang, "Link", "Ссылка"), type: "url" },
        { key: "keywords", name: tx(lang, "Keywords", "Ключевые слова"), type: "text" },
      ],
      views: [
        { type: "gallery", name: tx(lang, "Shelf", "Полка") },
        { type: "board", name: tx(lang, "By status", "По статусу"), groupBy: "status" },
        { type: "table", name: tx(lang, "Table", "Таблица") },
      ],
      rows: [
        { title: tx(lang, "The Master and Margarita", "Мастер и Маргарита"), icon: "📕", values: { author: tx(lang, "Mikhail Bulgakov", "Михаил Булгаков"), kind: { option: tx(lang, "Book", "Книга") }, status: { option: tx(lang, "Reading", "Читаю") }, rating: { option: "⭐⭐⭐⭐⭐" } } },
        { title: tx(lang, "Atomic Habits", "Атомные привычки"), icon: "📗", values: { author: tx(lang, "James Clear", "Джеймс Клир"), kind: { option: tx(lang, "Book", "Книга") }, status: { option: tx(lang, "Want to read", "Хочу прочитать") } } },
        { title: tx(lang, "How the internet works", "Как устроен интернет"), icon: "🌐", values: { kind: { option: tx(lang, "Article", "Статья") }, status: { option: tx(lang, "Finished", "Прочитано") }, rating: { option: "⭐⭐⭐⭐" } } },
      ],
    }),
  },
  {
    key: "weekly",
    category: "work",
    icon: "🗓️",
    build: (lang) => {
      const days = [tx(lang, "Monday", "Понедельник"), tx(lang, "Tuesday", "Вторник"), tx(lang, "Wednesday", "Среда"), tx(lang, "Thursday", "Четверг"), tx(lang, "Friday", "Пятница"), tx(lang, "Weekend", "Выходные")];
      return {
        kind: "page",
        title: tx(lang, "Weekly Planner", "Недельный планер"),
        icon: "🗓️",
        content: [
          callout("🎯", tx(lang, "Top three goals this week:", "Три главные цели недели:"), "yellow"),
          num(""),
          num(""),
          num(""),
          divider(),
          ...days.flatMap((d) => [{ type: "heading", props: { level: 3, isToggleable: true }, content: d, children: [todo(""), todo("")] } as B]),
          divider(),
          h3(tx(lang, "Weekly review", "Итоги недели")),
          p(tx(lang, "What went well? What moves to next week?", "Что получилось? Что перенести на следующую неделю?")),
        ],
      };
    },
  },
  {
    key: "docs",
    category: "work",
    icon: "📘",
    build: (lang) => ({
      kind: "page",
      title: tx(lang, "Project Docs", "Документация проекта"),
      icon: "📘",
      content: [
        { type: "toc" },
        h1(tx(lang, "Overview", "Обзор")),
        p(tx(lang, "Describe in a few lines what the project is and who it is for.", "Коротко опишите, что это за проект и для кого он.")),
        callout("ℹ️", tx(lang, "This is a living document: keep it up to date with the project.", "Документ живой: обновляйте его вместе с проектом."), "blue"),
        h1(tx(lang, "Getting started", "Быстрый старт")),
        num(tx(lang, "Clone the repository", "Клонируйте репозиторий")),
        num(tx(lang, "Install dependencies", "Установите зависимости")),
        code("bash", "git clone https://github.com/acme/app.git\ncd app && npm install\nnpm run dev"),
        h1(tx(lang, "Architecture", "Архитектура")),
        { type: "mermaid", props: { code: "graph LR\n  Client --> API\n  API --> DB[(Database)]\n  API --> Cache[(Cache)]" } },
        h1(tx(lang, "FAQ", "Вопросы и ответы")),
        toggle(tx(lang, "How do I deploy?", "Как задеплоить?"), [p(tx(lang, "Run npm run build and follow the deploy guide.", "Запустите npm run build и следуйте инструкции деплоя."))]),
        toggle(tx(lang, "Where do I report bugs?", "Куда писать об ошибках?"), [p(tx(lang, "Open an issue in the tracker.", "Создайте задачу в трекере."))]),
      ],
    }),
  },
  {
    key: "habits",
    category: "life",
    icon: "🔁",
    build: (lang) => ({
      kind: "database",
      title: tx(lang, "Habit Tracker", "Трекер привычек"),
      icon: "🔁",
      props: [
        { key: "date", name: tx(lang, "Date", "Дата"), type: "date" },
        { key: "water", name: tx(lang, "💧 Water", "💧 Вода"), type: "checkbox" },
        { key: "sport", name: tx(lang, "🏃 Exercise", "🏃 Спорт"), type: "checkbox" },
        { key: "read", name: tx(lang, "📖 Reading", "📖 Чтение"), type: "checkbox" },
        { key: "sleep", name: tx(lang, "😴 Sleep 8h", "😴 Сон 8 ч"), type: "checkbox" },
      ],
      views: [{ type: "table", name: tx(lang, "Days", "Дни") }],
      rows: [0, -1, -2, -3, -4].map((d, i) => ({
        title: new Date(Date.now() + d * 86_400_000).toLocaleDateString(intlOf(lang), { weekday: "long", day: "numeric", month: "short" }),
        values: { date: { start: day(d) }, water: i % 2 === 0, sport: i % 3 === 0, read: i !== 2, sleep: i % 2 === 1 },
      })),
    }),
  },
  {
    key: "roadmap",
    category: "work",
    icon: "🛣️",
    build: (lang) => ({
      kind: "database",
      title: tx(lang, "Roadmap", "Дорожная карта"),
      icon: "🛣️",
      props: [
        { key: "q", name: tx(lang, "Quarter", "Квартал"), type: "select", options: [
          { name: "Q1", color: "blue" },
          { name: "Q2", color: "green" },
          { name: "Q3", color: "orange" },
          { name: "Q4", color: "purple" },
        ] },
        { key: "status", name: tx(lang, "Status", "Статус"), type: "status", options: [
          { name: tx(lang, "Planned", "Запланировано"), color: "gray", group: "todo" },
          { name: tx(lang, "Building", "В разработке"), color: "blue", group: "doing" },
          { name: tx(lang, "Shipped", "Выпущено"), color: "green", group: "done" },
        ] },
        { key: "when", name: tx(lang, "Date", "Дата"), type: "date" },
      ],
      views: [
        { type: "board", name: tx(lang, "By quarter", "По кварталам"), groupBy: "q" },
        { type: "calendar", name: tx(lang, "Calendar", "Календарь"), dateProp: "when" },
        { type: "table", name: tx(lang, "All", "Все") },
      ],
      rows: [
        { title: tx(lang, "Dark mode", "Тёмная тема"), values: { q: { option: "Q1" }, status: { option: tx(lang, "Shipped", "Выпущено") }, when: { start: day(-20) } } },
        { title: tx(lang, "Collaboration", "Совместная работа"), values: { q: { option: "Q2" }, status: { option: tx(lang, "Building", "В разработке") }, when: { start: day(14) } } },
        { title: tx(lang, "Offline mode", "Офлайн-режим"), values: { q: { option: "Q3" }, status: { option: tx(lang, "Planned", "Запланировано") }, when: { start: day(60) } } },
      ],
    }),
  },
  {
    key: "personal",
    category: "life",
    icon: "🏠",
    build: (lang) => ({
      kind: "page",
      title: tx(lang, "Personal Home", "Личная главная"),
      icon: "🏠",
      cover: "g-navy",
      content: [
        callout("☀️", tx(lang, "Hi! Everything that matters today lives here.", "Привет! Здесь всё, что важно сегодня."), "yellow"),
        h2(tx(lang, "Quick links", "Быстрые ссылки")),
      ],
      children: [
        {
          kind: "database",
          title: tx(lang, "Tasks", "Задачи"),
          icon: "✅",
          inline: true,
          props: [
            { key: "done", name: tx(lang, "Done", "Готово"), type: "checkbox" },
            { key: "due", name: tx(lang, "Due", "Срок"), type: "date" },
          ],
          views: [{ type: "table", name: tx(lang, "Tasks", "Задачи") }],
          rows: [
            { title: tx(lang, "Plan the week", "Спланировать неделю"), values: { done: false, due: { start: day(0) } } },
            { title: tx(lang, "Call mom", "Позвонить маме"), values: { done: false, due: { start: day(1) } } },
          ],
        },
        { kind: "page", title: tx(lang, "Ideas", "Идеи"), icon: "💡", content: [bullet(""), bullet("")] },
        { kind: "page", title: tx(lang, "Yearly goals", "Цели на год"), icon: "🎯", content: [todo(""), todo(""), todo("")] },
      ],
    }),
  },
  {
    key: "notes",
    category: "life",
    icon: "📝",
    build: (lang) => ({
      kind: "page",
      title: tx(lang, "Quick Note", "Быстрая заметка"),
      icon: "📝",
      content: [p(tx(lang, "Jot it down while it's fresh.", "Записывайте мысли, пока они свежие.")), p("")],
    }),
  },
  // ---------------------------------------------------------------- zvena: team
  {
    key: "teamWiki",
    category: "team",
    icon: "📚",
    build: (lang) => ({
      kind: "page",
      title: tx(lang, "Team wiki", "База знаний команды"),
      icon: "📚",
      cover: "blue",
      content: [
        callout("👋", tx(lang, "Everything a new teammate needs: how we work, where things are and whom to ask.", "Всё, что нужно знать новому человеку в команде: как мы работаем, где что лежит и к кому идти с вопросами."), "blue"),
        h2(tx(lang, "Sections", "Разделы")),
        p(tx(lang, "Each section is a page. Add your own with + or /page.", "Каждый раздел — отдельная страница. Добавляйте свои через «+» или «/страница».")),
      ],
      children: [
        {
          kind: "page",
          title: tx(lang, "About the team", "О команде"),
          icon: "🧭",
          content: [
            h2(tx(lang, "Mission", "Миссия")),
            p(tx(lang, "In one line: why the team exists and whom it helps.", "Одной фразой: зачем существует команда и кому она помогает.")),
            h2(tx(lang, "Who is who", "Кто есть кто")),
            bullet(tx(lang, "Name — role — what to ask them about", "Имя — роль — чем можно помочь")),
            h2(tx(lang, "Rituals", "Ритуалы")),
            bullet(tx(lang, "Monday 10:00 — weekly planning", "Понедельник 10:00 — планирование недели")),
            bullet(tx(lang, "Friday 17:00 — demo and retro", "Пятница 17:00 — демо и ретро")),
          ],
        },
        {
          kind: "page",
          title: tx(lang, "Processes", "Процессы"),
          icon: "⚙️",
          content: [
            h2(tx(lang, "How we take tasks", "Как берём задачи")),
            num(tx(lang, "A task lands in the tracker as “New”.", "Задача попадает в трекер со статусом «Новая».")),
            num(tx(lang, "At planning we set an owner and a due date.", "На планировании назначаем ответственного и срок.")),
            num(tx(lang, "Done = checked by a second person.", "Готово = проверено вторым человеком.")),
            h2(tx(lang, "How we review designs", "Как ревьюим макеты")),
            p(tx(lang, "Insert the frame with /design and leave comments in Design.", "Вставьте фрейм через «/макет» и оставляйте комментарии прямо в Дизайне.")),
          ],
        },
        {
          kind: "database",
          title: tx(lang, "Glossary", "Глоссарий"),
          icon: "🔤",
          props: [
            { key: "def", name: tx(lang, "Definition", "Определение"), type: "text" },
            { key: "area", name: tx(lang, "Area", "Область"), type: "select", options: [
              { name: tx(lang, "Product", "Продукт"), color: "blue" },
              { name: tx(lang, "Engineering", "Разработка"), color: "green" },
              { name: tx(lang, "Design", "Дизайн"), color: "purple" },
            ] },
          ],
          views: [{ type: "table", name: tx(lang, "All terms", "Все термины") }],
          rows: [
            { title: "MVP", values: { def: tx(lang, "The smallest product that tests a hypothesis.", "Минимальная версия продукта, на которой проверяют гипотезу."), area: { option: tx(lang, "Product", "Продукт") } } },
            { title: tx(lang, "Auto layout", "Авто-раскладка"), values: { def: tx(lang, "A frame that places its children by flex rules.", "Фрейм сам расставляет вложенные элементы по правилам flex."), area: { option: tx(lang, "Design", "Дизайн") } } },
          ],
        },
      ],
    }),
  },
  {
    key: "productSpec",
    category: "team",
    icon: "🧩",
    build: (lang) => ({
      kind: "page",
      title: tx(lang, "Product spec", "Спецификация продукта"),
      icon: "🧩",
      content: [
        callout("📌", [bold(tx(lang, "Status: ", "Статус: ")), plain(tx(lang, "draft · Owner: … · Updated: …", "черновик · Владелец: … · Обновлено: …"))], "gray"),
        h2(tx(lang, "Problem", "Проблема")),
        p(tx(lang, "What is wrong today and for whom. Facts, no solution yet.", "Что сейчас не так и у кого. Факты и цифры, без решения.")),
        h2(tx(lang, "Goals and metrics", "Цели и метрики")),
        bullet(tx(lang, "Goal: …  Metric: …  Now: …  Target in 3 months: …", "Цель: …  Метрика: …  Сейчас: …  Цель через 3 месяца: …")),
        h2(tx(lang, "Users and scenarios", "Пользователи и сценарии")),
        bullet(tx(lang, "As a [role], I want [action] so that [value].", "Как [роль], я хочу [действие], чтобы [ценность].")),
        h2(tx(lang, "Solution", "Решение")),
        p(tx(lang, "How it will work. Insert designs with /design.", "Как это будет работать. Вставьте макеты: «/макет».")),
        { type: "design" },
        h2(tx(lang, "Out of scope", "Вне рамок")),
        bullet(tx(lang, "What we deliberately leave out.", "Что сознательно не делаем в этой версии.")),
        h2(tx(lang, "Open questions", "Открытые вопросы")),
        todo(tx(lang, "…", "…")),
      ],
      children: [
        {
          kind: "database",
          title: tx(lang, "Requirements", "Требования"),
          icon: "✅",
          inline: true,
          props: [
            { key: "prio", name: tx(lang, "Priority", "Приоритет"), type: "select", options: [
              { name: tx(lang, "Must", "Обязательно"), color: "red" },
              { name: tx(lang, "Should", "Желательно"), color: "orange" },
              { name: tx(lang, "Could", "Можно"), color: "gray" },
            ] },
            { key: "status", name: tx(lang, "Status", "Статус"), type: "status", options: [
              { name: tx(lang, "Discussing", "Обсуждаем"), color: "gray", group: "todo" },
              { name: tx(lang, "Agreed", "Согласовано"), color: "blue", group: "doing" },
              { name: tx(lang, "Done", "Сделано"), color: "green", group: "done" },
            ] },
            { key: "notes", name: tx(lang, "Notes", "Комментарий"), type: "text" },
          ],
          views: [{ type: "table", name: tx(lang, "All requirements", "Все требования") }],
          rows: [
            { title: tx(lang, "Sign-in with Google and Apple", "Вход через Google и Apple"), values: { prio: { option: tx(lang, "Must", "Обязательно") }, status: { option: tx(lang, "Agreed", "Согласовано") } } },
            { title: tx(lang, "PDF export", "Экспорт в PDF"), values: { prio: { option: tx(lang, "Should", "Желательно") }, status: { option: tx(lang, "Discussing", "Обсуждаем") } } },
          ],
        },
      ],
    }),
  },
  {
    key: "taskTracker",
    category: "team",
    icon: "🗂️",
    build: (lang) => ({
      kind: "database",
      title: tx(lang, "Task tracker", "Трекер задач"),
      icon: "🗂️",
      props: [
        { key: "status", name: tx(lang, "Status", "Статус"), type: "status", options: [
          { name: tx(lang, "New", "Новая"), color: "gray", group: "todo" },
          { name: tx(lang, "In progress", "В работе"), color: "blue", group: "doing" },
          { name: tx(lang, "Review", "На проверке"), color: "purple", group: "doing" },
          { name: tx(lang, "Done", "Готово"), color: "green", group: "done" },
        ] },
        { key: "who", name: tx(lang, "Assignee", "Исполнитель"), type: "text" },
        { key: "prio", name: tx(lang, "Priority", "Приоритет"), type: "select", options: [
          { name: tx(lang, "Urgent", "Срочно"), color: "red" },
          { name: tx(lang, "High", "Высокий"), color: "orange" },
          { name: tx(lang, "Normal", "Обычный"), color: "gray" },
        ] },
        { key: "due", name: tx(lang, "Due", "Срок"), type: "date" },
        { key: "sprint", name: tx(lang, "Sprint", "Спринт"), type: "select", options: [
          { name: tx(lang, "Sprint 1", "Спринт 1"), color: "blue" },
          { name: tx(lang, "Sprint 2", "Спринт 2"), color: "green" },
        ] },
      ],
      views: [
        { type: "board", name: tx(lang, "Board", "Доска"), groupBy: "status" },
        { type: "table", name: tx(lang, "All tasks", "Все задачи") },
        { type: "calendar", name: tx(lang, "Calendar", "Календарь"), dateProp: "due" },
      ],
      rows: [
        { title: tx(lang, "Collect release requirements", "Собрать требования к релизу"), values: { status: { option: tx(lang, "In progress", "В работе") }, who: tx(lang, "Ana", "Аня"), prio: { option: tx(lang, "High", "Высокий") }, due: { start: day(2) }, sprint: { option: tx(lang, "Sprint 1", "Спринт 1") } } },
        { title: tx(lang, "Home screen mockup", "Макет главного экрана"), values: { status: { option: tx(lang, "Review", "На проверке") }, who: tx(lang, "Ben", "Борис"), prio: { option: tx(lang, "Urgent", "Срочно") }, due: { start: day(1) }, sprint: { option: tx(lang, "Sprint 1", "Спринт 1") } } },
        { title: tx(lang, "Set up backups", "Настроить резервное копирование"), values: { status: { option: tx(lang, "New", "Новая") }, who: tx(lang, "Vic", "Вика"), prio: { option: tx(lang, "Normal", "Обычный") }, due: { start: day(9) }, sprint: { option: tx(lang, "Sprint 2", "Спринт 2") } } },
      ],
    }),
  },
  {
    key: "diploma",
    category: "school",
    icon: "🎓",
    build: (lang) => ({
      kind: "page",
      title: tx(lang, "Thesis project", "Дипломный проект (ВКР)"),
      icon: "🎓",
      cover: "purple",
      content: [
        callout("🗓️", tx(lang, "Plan, deadlines, sources and supervisor meetings in one place.", "План, сроки, литература и встречи с руководителем — в одном месте. Отмечайте готовое, чтобы видеть прогресс."), "purple"),
        h2(tx(lang, "Topic and aim", "Тема и цель")),
        p(tx(lang, "Topic: …", "Тема: …")),
        p(tx(lang, "Aim: … Objectives: 1) … 2) … 3) …", "Цель: … Задачи: 1) … 2) … 3) …")),
        h2(tx(lang, "Structure", "Структура работы")),
        todo(tx(lang, "Introduction", "Введение (актуальность, цель, задачи, объект и предмет)")),
        todo(tx(lang, "Chapter 1. Theory", "Глава 1. Теоретическая часть")),
        todo(tx(lang, "Chapter 2. Practice", "Глава 2. Практическая часть")),
        todo(tx(lang, "Conclusion", "Заключение")),
        todo(tx(lang, "References", "Список литературы (ГОСТ Р 7.0.100-2018)")),
        todo(tx(lang, "Appendices", "Приложения")),
        h2(tx(lang, "Formatting", "Оформление")),
        bullet(tx(lang, "Times New Roman 14 pt, 1.5 spacing, margins 30/15/20/20 mm.", "Шрифт Times New Roman 14 пт, интервал 1,5, поля: левое 30 мм, правое 15 мм, верхнее и нижнее 20 мм.")),
        bullet(tx(lang, "Check your department's rules — they may differ.", "Проверьте требования своей кафедры — они могут отличаться.")),
      ],
      children: [
        {
          kind: "database",
          title: tx(lang, "Schedule", "График работы"),
          icon: "⏳",
          props: [
            { key: "stage", name: tx(lang, "Stage", "Этап"), type: "status", options: [
              { name: tx(lang, "Not started", "Не начато"), color: "gray", group: "todo" },
              { name: tx(lang, "In progress", "В работе"), color: "blue", group: "doing" },
              { name: tx(lang, "Submitted", "Сдано"), color: "green", group: "done" },
            ] },
            { key: "when", name: tx(lang, "Dates", "Сроки"), type: "date" },
          ],
          views: [
            { type: "timeline", name: tx(lang, "Timeline", "Хронология"), dateProp: "when" },
            { type: "table", name: tx(lang, "Table", "Таблица") },
          ],
          rows: [
            { title: tx(lang, "Approve the topic", "Утвердить тему"), values: { stage: { option: tx(lang, "Submitted", "Сдано") }, when: { start: day(-20), end: day(-14) } } },
            { title: tx(lang, "Chapter 1", "Глава 1"), values: { stage: { option: tx(lang, "In progress", "В работе") }, when: { start: day(-10), end: day(15) } } },
            { title: tx(lang, "Chapter 2", "Глава 2"), values: { stage: { option: tx(lang, "Not started", "Не начато") }, when: { start: day(16), end: day(45) } } },
            { title: tx(lang, "Pre-defence", "Предзащита"), values: { stage: { option: tx(lang, "Not started", "Не начато") }, when: { start: day(60) } } },
          ],
        },
        {
          kind: "database",
          title: tx(lang, "Sources", "Литература"),
          icon: "📖",
          props: [
            { key: "author", name: tx(lang, "Author", "Автор"), type: "text" },
            { key: "year", name: tx(lang, "Year", "Год"), type: "number" },
            { key: "kind", name: tx(lang, "Type", "Тип"), type: "select", options: [
              { name: tx(lang, "Book", "Книга"), color: "brown" },
              { name: tx(lang, "Article", "Статья"), color: "blue" },
              { name: tx(lang, "Website", "Сайт"), color: "gray" },
            ] },
            { key: "used", name: tx(lang, "Used", "Использовано"), type: "checkbox" },
          ],
          views: [{ type: "table", name: tx(lang, "All sources", "Все источники") }],
          rows: [{ title: tx(lang, "Source title", "Название источника"), values: { author: tx(lang, "Surname N.", "Фамилия И. О."), year: 2024, kind: { option: tx(lang, "Book", "Книга") } } }],
        },
        {
          kind: "database",
          title: tx(lang, "Supervisor meetings", "Встречи с руководителем"),
          icon: "🤝",
          props: [
            { key: "date", name: tx(lang, "Date", "Дата"), type: "date" },
            { key: "result", name: tx(lang, "Outcome", "Итоги"), type: "text" },
          ],
          views: [{ type: "table", name: tx(lang, "Meetings", "Встречи") }],
          rows: [{ title: tx(lang, "Plan review", "Обсуждение плана"), values: { date: { start: day(3) }, result: tx(lang, "Refine chapter 2 goals", "Уточнить задачи второй главы") } }],
        },
      ],
    }),
  },
  {
    key: "sprint",
    category: "team",
    icon: "🏃",
    build: (lang) => ({
      kind: "page",
      title: tx(lang, "Sprint and retro", "Спринт и ретро"),
      icon: "🏃",
      content: [
        h2(tx(lang, "Sprint goal", "Цель спринта")),
        p(tx(lang, "What becomes possible by the end of the sprint.", "Что должно стать возможным к концу спринта.")),
        h2(tx(lang, "Commitments", "Обязательства")),
        todo(tx(lang, "Task 1", "Задача 1")),
        todo(tx(lang, "Task 2", "Задача 2")),
        h2(tx(lang, "Retrospective", "Ретроспектива")),
        columns(
          col(1, [h3(tx(lang, "😊 Went well", "😊 Что было хорошо")), bullet("")]),
          col(1, [h3(tx(lang, "🤔 Got in the way", "🤔 Что мешало")), bullet("")]),
          col(1, [h3(tx(lang, "🚀 We will try", "🚀 Что попробуем")), bullet("")])
        ),
      ],
    }),
  },
  {
    key: "onboarding",
    category: "team",
    icon: "🧑‍🚀",
    build: (lang) => ({
      kind: "page",
      title: tx(lang, "Onboarding", "Онбординг сотрудника"),
      icon: "🧑‍🚀",
      content: [
        callout("🙌", tx(lang, "Welcome! Follow the checklist — by the end of week two you will know the ropes.", "Добро пожаловать! Пройдите по чек-листу — к концу второй недели вы будете в курсе всего."), "green"),
        h2(tx(lang, "Day 1", "День 1")),
        todo(tx(lang, "Sign in to zvena and join the team workspace", "Войти в zvena и вступить в пространство команды по ссылке")),
        todo(tx(lang, "Read the team wiki", "Прочитать «Базу знаний команды»")),
        todo(tx(lang, "Meet your buddy", "Познакомиться с наставником")),
        h2(tx(lang, "Week 1", "Неделя 1")),
        todo(tx(lang, "Set up your tools", "Настроить рабочие инструменты")),
        todo(tx(lang, "Take a first small task from the tracker", "Взять первую небольшую задачу из трекера")),
        h2(tx(lang, "Week 2", "Неделя 2")),
        todo(tx(lang, "Show your result at the demo", "Показать результат на демо")),
        todo(tx(lang, "Agree quarterly goals with your lead", "Обсудить с руководителем цели на квартал")),
      ],
    }),
  },
  {
    key: "techSpec",
    category: "team",
    icon: "📐",
    build: (lang) => ({
      kind: "page",
      title: tx(lang, "Technical specification", "Техническое задание"),
      icon: "📐",
      content: [
        p(tx(lang, "A structure inspired by GOST 34.602 — remove what you do not need.", "Структура по мотивам ГОСТ 34.602 — удалите лишние разделы.")),
        h2(tx(lang, "1. General", "1. Общие сведения")),
        p(tx(lang, "System name, customer, contractor, dates.", "Наименование системы, заказчик, исполнитель, сроки.")),
        h2(tx(lang, "2. Purpose and goals", "2. Назначение и цели")),
        h2(tx(lang, "3. The object being automated", "3. Характеристика объекта автоматизации")),
        h2(tx(lang, "4. Requirements", "4. Требования к системе")),
        h3(tx(lang, "4.1. Functional", "4.1. Функциональные требования")),
        h3(tx(lang, "4.2. Non-functional", "4.2. Нефункциональные требования")),
        bullet(tx(lang, "Performance, reliability, security, personal data.", "Производительность, надёжность, безопасность, хранение персональных данных (GDPR).")),
        h2(tx(lang, "5. Scope of work", "5. Состав и содержание работ")),
        h2(tx(lang, "6. Acceptance", "6. Порядок контроля и приёмки")),
        h2(tx(lang, "7. Documentation", "7. Требования к документированию")),
        h2(tx(lang, "8. References", "8. Источники разработки")),
      ],
    }),
  },
  {
    key: "userResearch",
    category: "team",
    icon: "🔎",
    build: (lang) => ({
      kind: "page",
      title: tx(lang, "User research", "Исследование пользователей"),
      icon: "🔎",
      content: [
        h2(tx(lang, "Research question", "Вопрос исследования")),
        p(tx(lang, "What we want to learn and which decision depends on it.", "Что мы хотим узнать и какое решение примем по итогам.")),
        h2(tx(lang, "Hypotheses", "Гипотезы")),
        bullet(tx(lang, "We believe … because …", "Мы считаем, что … потому что …")),
        h2(tx(lang, "Insights", "Выводы")),
        callout("💡", tx(lang, "Filled in after the interviews.", "Заполняется после интервью."), "yellow"),
      ],
      children: [
        {
          kind: "database",
          title: tx(lang, "Interviews", "Интервью"),
          icon: "🎙️",
          inline: true,
          props: [
            { key: "date", name: tx(lang, "Date", "Дата"), type: "date" },
            { key: "segment", name: tx(lang, "Segment", "Сегмент"), type: "select", options: [
              { name: tx(lang, "Student", "Студент"), color: "blue" },
              { name: tx(lang, "Designer", "Дизайнер"), color: "purple" },
              { name: tx(lang, "Manager", "Менеджер"), color: "orange" },
            ] },
            { key: "insight", name: tx(lang, "Key insight", "Главное"), type: "text" },
          ],
          views: [{ type: "table", name: tx(lang, "All interviews", "Все интервью") }],
          rows: [{ title: tx(lang, "Participant 1", "Респондент 1"), values: { date: { start: day(2) }, segment: { option: tx(lang, "Designer", "Дизайнер") } } }],
        },
      ],
    }),
  },
  {
    key: "designReview",
    category: "team",
    icon: "🎨",
    build: (lang) => ({
      kind: "page",
      title: tx(lang, "Design review", "Дизайн-ревью"),
      icon: "🎨",
      content: [
        p(tx(lang, "Insert the frame under review — its preview updates as it changes.", "Вставьте фрейм на проверку — превью будет обновляться по мере правок.")),
        { type: "design" },
        h2(tx(lang, "Checklist", "Чек-лист")),
        todo(tx(lang, "Copy is correct and consistent", "Тексты без ошибок, единый тон")),
        todo(tx(lang, "Spacing follows the grid", "Отступы кратны сетке, выравнивания ровные")),
        todo(tx(lang, "Text contrast is at least 4.5:1", "Контраст текста не ниже 4,5:1")),
        todo(tx(lang, "States: hover, pressed, error, empty, loading", "Состояния: наведение, нажатие, ошибка, пусто, загрузка")),
        todo(tx(lang, "Library components, no detached copies", "Компоненты из библиотеки, без «отвязанных» копий")),
        todo(tx(lang, "Phone layout", "Версия для телефона")),
        h2(tx(lang, "Notes", "Замечания")),
        bullet(""),
      ],
    }),
  },
  {
    key: "brief",
    category: "team",
    icon: "📝",
    build: (lang) => ({
      kind: "page",
      title: tx(lang, "Design brief", "Бриф на дизайн"),
      icon: "📝",
      content: [
        h2(tx(lang, "About the project", "О проекте")),
        p(tx(lang, "What we are making and for whom.", "Что делаем и для кого.")),
        h2(tx(lang, "Design goals", "Задачи дизайна")),
        bullet(tx(lang, "What the user should feel and do.", "Что должен почувствовать и сделать пользователь.")),
        h2(tx(lang, "Must include", "Обязательные элементы")),
        bullet(tx(lang, "Logo, contacts, …", "Логотип, контакты, …")),
        h2(tx(lang, "References", "Референсы")),
        bullet(tx(lang, "Links to examples you like, and why.", "Ссылки на примеры, которые нравятся, и почему.")),
        h2(tx(lang, "Timeline and budget", "Сроки и бюджет")),
        p(tx(lang, "First drafts: … Final: …", "Первые варианты: … Финальная версия: …")),
      ],
    }),
  },
  {
    key: "okr",
    category: "team",
    icon: "🎯",
    build: (lang) => ({
      kind: "database",
      title: tx(lang, "Objectives and key results", "Цели и ключевые результаты (OKR)"),
      icon: "🎯",
      props: [
        { key: "objective", name: tx(lang, "Objective", "Цель"), type: "select", options: [
          { name: tx(lang, "Grow the audience", "Растём аудиторией"), color: "blue" },
          { name: tx(lang, "Make the product easier", "Делаем продукт удобнее"), color: "green" },
        ] },
        { key: "progress", name: tx(lang, "Progress, %", "Прогресс, %"), type: "number" },
        { key: "owner", name: tx(lang, "Owner", "Ответственный"), type: "text" },
        { key: "quarter", name: tx(lang, "Quarter", "Квартал"), type: "select", options: [{ name: "Q4", color: "purple" }] },
      ],
      views: [
        { type: "board", name: tx(lang, "By objective", "По целям"), groupBy: "objective" },
        { type: "table", name: tx(lang, "All key results", "Все результаты") },
      ],
      rows: [
        { title: tx(lang, "1,000 active teams", "1 000 активных команд"), values: { objective: { option: tx(lang, "Grow the audience", "Растём аудиторией") }, progress: 35, owner: tx(lang, "Ana", "Аня"), quarter: { option: "Q4" } } },
        { title: tx(lang, "Time to first doc < 1 min", "Время до первого документа < 1 мин"), values: { objective: { option: tx(lang, "Make the product easier", "Делаем продукт удобнее") }, progress: 60, owner: tx(lang, "Ben", "Борис"), quarter: { option: "Q4" } } },
      ],
    }),
  },
  {
    key: "releases",
    category: "team",
    icon: "🚢",
    build: (lang) => ({
      kind: "database",
      title: tx(lang, "Release log", "Журнал релизов"),
      icon: "🚢",
      props: [
        { key: "date", name: tx(lang, "Date", "Дата"), type: "date" },
        { key: "kind", name: tx(lang, "Type", "Тип"), type: "multi_select", options: [
          { name: tx(lang, "New", "Новое"), color: "green" },
          { name: tx(lang, "Improvement", "Улучшение"), color: "blue" },
          { name: tx(lang, "Fix", "Исправление"), color: "orange" },
        ] },
        { key: "summary", name: tx(lang, "Summary", "Кратко"), type: "text" },
      ],
      views: [
        { type: "list", name: tx(lang, "Feed", "Лента") },
        { type: "calendar", name: tx(lang, "Calendar", "Календарь"), dateProp: "date" },
      ],
      rows: [
        { title: "1.0", values: { date: { start: day(-3) }, kind: { options: [tx(lang, "New", "Новое")] }, summary: tx(lang, "First public release", "Первый публичный релиз") } },
      ],
    }),
  },
];

/** Creates a template's notes under `parentId`; returns the root note. */
export function instantiateTemplate(tpl: Template, lang: string, store: NotesStore, parentId: string | null): Note {
  const build = (node: TplNode, parent: string | null): Note => {
    if (node.kind === "page") {
      const n = store.create({
        kind: "page",
        parentId: parent,
        title: node.title,
        icon: node.icon,
        cover: node.cover ? { kind: "gradient", value: node.cover, y: 50 } : null,
        content: [],
      });
      const extra: B[] = [];
      for (const child of node.children ?? []) {
        const c = build(child, n.id);
        extra.push({ type: child.kind === "database" && child.inline ? "database" : "page", props: { noteId: c.id } });
      }
      store.update(n.id, { content: [...(node.content ?? []), ...extra] }, { quiet: true });
      return n;
    }
    // Database: properties keyed by template key → real ids; option names → ids.
    const keyToId = new Map<string, string>();
    const properties: DbProperty[] = [{ id: "title", name: tx(lang, "Name", "Название"), type: "title" }];
    for (const spec of node.props ?? []) {
      const id = shortId();
      keyToId.set(spec.key, id);
      properties.push({
        id,
        name: spec.name,
        type: spec.type,
        ...(spec.options ? { options: spec.options.map((o) => ({ id: shortId(), name: o.name, color: o.color, ...(o.group ? { group: o.group } : {}) })) } : {}),
      });
    }
    const schema: DbSchema = { properties, views: [] };
    for (const v of node.views ?? [{ type: "table" as const, name: tx(lang, "Table", "Таблица") }]) {
      const view = defaultView(v.type, v.name, schema);
      if (v.groupBy) view.groupBy = keyToId.get(v.groupBy);
      if (v.dateProp) view.dateProp = keyToId.get(v.dateProp);
      schema.views.push(view);
    }
    const db = store.create({ kind: "database", parentId: parent, title: node.title, icon: node.icon, db: schema, inline: node.inline || undefined });
    let order = Date.now();
    for (const r of node.rows ?? []) {
      const props: Record<string, PropValue> = {};
      for (const [k, raw] of Object.entries(r.values)) {
        const id = keyToId.get(k);
        const prop = properties.find((x) => x.id === id);
        if (!id || !prop || raw === undefined) continue;
        if (raw && typeof raw === "object" && "option" in raw) props[id] = prop.options?.find((o) => o.name === raw.option)?.id ?? null;
        else if (raw && typeof raw === "object" && "options" in raw) props[id] = raw.options.map((name) => prop.options?.find((o) => o.name === name)?.id).filter((x): x is string => Boolean(x));
        else props[id] = raw as PropValue;
      }
      store.put({ ...blankNote({ kind: "page", parentId: db.id, title: r.title, icon: r.icon ?? "", props, content: r.content ?? [] }), order: order++ });
    }
    return db;
  };
  return build(tpl.build(lang), parentId);
}
