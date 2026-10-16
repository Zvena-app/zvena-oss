// The words of a new workspace's first board, in every interface language:
// the team's name, its workflow statuses, its labels and the three example
// issues. They are data (people rename them), so they are written once, in the
// language of the person who opened Projects first.

import type { StatusCategory } from "./types";

export interface Seed {
  team: string;
  /** Backlog, Todo, In progress, In review, Done, Canceled, Duplicate (sentence case, like the rest of zvena). */
  statuses: [string, string, string, string, string, string, string];
  /** Bug, Improvement, Feature. */
  labels: [string, string, string];
  examples: [{ title: string; description: string }, { title: string; description: string }, { title: string; description: string }];
}

export const STATUS_SHAPE: [StatusCategory, string][] = [
  ["backlog", "#95a2b3"],
  ["unstarted", "#99a2b2"],
  ["started", "#f2c94c"],
  ["started", "#4cb782"],
  ["completed", "#5e6ad2"],
  ["canceled", "#95a2b3"],
  ["canceled", "#95a2b3"],
];
/** The seeded "Duplicate" status (STATUS_SHAPE's place): a team's duplicate status from the start. */
export const DUPLICATE_SEAT = 6;
export const LABEL_COLORS = ["#d44c47", "#337ea9", "#9065b0"];

const S: Record<string, Seed> = {
  en: {
    team: "My team",
    statuses: ["Backlog", "Todo", "In progress", "In review", "Done", "Canceled", "Duplicate"],
    labels: ["Bug", "Improvement", "Feature"],
    examples: [
      { title: "Press C to create an issue", description: "Create an issue from anywhere with **C** or the New issue button. Ctrl/⌘+Enter creates it.\n\n- [ ] Create your first issue\n- [ ] Delete this example" },
      { title: "Drag this card to In progress", description: "Change status, assignee and priority by dragging on the board, by clicking a property, or with **S**, **A**, **P**." },
      { title: "Open an issue and @mention a teammate", description: "A click opens the issue on the side, Enter opens the full page. Descriptions and comments support lists, checklists and @mentions — the person you mention is notified in their Inbox." },
    ],
  },
  ru: {
    team: "Моя команда",
    statuses: ["Бэклог", "К выполнению", "В работе", "На проверке", "Готово", "Отменено", "Дубликат"],
    labels: ["Баг", "Улучшение", "Фича"],
    examples: [
      { title: "Нажмите C, чтобы создать задачу", description: "Новая задача создаётся из любого места клавишей **C** или кнопкой «Новая задача». Ctrl/⌘+Enter — создать.\n\n- [ ] Создайте свою первую задачу\n- [ ] Удалите этот пример" },
      { title: "Перетащите эту карточку в «В работе»", description: "Статус, исполнителя и приоритет можно менять перетаскиванием на доске, кликом по свойству или клавишами **S**, **A**, **P**." },
      { title: "Откройте задачу и упомяните коллегу через @", description: "Клик открывает задачу сбоку, Enter — на всю страницу. В описании и комментариях работают списки, чек-листы и @упоминания — упомянутый получит уведомление во «Входящих»." },
    ],
  },
  es: {
    team: "Mi equipo",
    statuses: ["Backlog", "Por hacer", "En curso", "En revisión", "Hecho", "Cancelado", "Duplicado"],
    labels: ["Bug", "Mejora", "Funcionalidad"],
    examples: [
      { title: "Pulsa C para crear una incidencia", description: "Crea una incidencia desde cualquier lugar con **C** o con el botón Nueva incidencia. Ctrl/⌘+Enter la crea.\n\n- [ ] Crea tu primera incidencia\n- [ ] Borra este ejemplo" },
      { title: "Arrastra esta tarjeta a En curso", description: "Cambia el estado, el responsable y la prioridad arrastrando en el tablero, haciendo clic en una propiedad o con **S**, **A**, **P**." },
      { title: "Abre una incidencia y menciona a alguien con @", description: "Un clic abre la incidencia a un lado; Enter, a pantalla completa. Las descripciones y los comentarios admiten listas, checklists y @menciones: la persona mencionada recibe un aviso en su Bandeja de entrada." },
    ],
  },
  fr: {
    team: "Mon équipe",
    statuses: ["Backlog", "À faire", "En cours", "En revue", "Terminé", "Annulé", "Doublon"],
    labels: ["Bug", "Amélioration", "Fonctionnalité"],
    examples: [
      { title: "Appuyez sur C pour créer un ticket", description: "Créez un ticket de n’importe où avec **C** ou le bouton Nouveau ticket. Ctrl/⌘+Entrée le crée.\n\n- [ ] Créez votre premier ticket\n- [ ] Supprimez cet exemple" },
      { title: "Glissez cette carte vers En cours", description: "Changez le statut, la personne assignée et la priorité en glissant sur le tableau, en cliquant sur une propriété ou avec **S**, **A**, **P**." },
      { title: "Ouvrez un ticket et mentionnez un collègue avec @", description: "Un clic ouvre le ticket sur le côté, Entrée l’ouvre en pleine page. Descriptions et commentaires acceptent listes, cases à cocher et @mentions : la personne mentionnée est prévenue dans sa boîte de réception." },
    ],
  },
  pt: {
    team: "Minha equipe",
    statuses: ["Backlog", "A fazer", "Em andamento", "Em revisão", "Concluído", "Cancelado", "Duplicado"],
    labels: ["Bug", "Melhoria", "Funcionalidade"],
    examples: [
      { title: "Pressione C para criar um item", description: "Crie um item de qualquer lugar com **C** ou com o botão Novo item. Ctrl/⌘+Enter cria.\n\n- [ ] Crie seu primeiro item\n- [ ] Apague este exemplo" },
      { title: "Arraste este cartão para Em andamento", description: "Mude status, responsável e prioridade arrastando no quadro, clicando numa propriedade ou com **S**, **A**, **P**." },
      { title: "Abra um item e mencione um colega com @", description: "Um clique abre o item ao lado; Enter abre a página inteira. Descrições e comentários aceitam listas, checklists e @menções — quem for mencionado recebe um aviso na Caixa de entrada." },
    ],
  },
  id: {
    team: "Tim saya",
    statuses: ["Backlog", "Akan dikerjakan", "Sedang dikerjakan", "Ditinjau", "Selesai", "Dibatalkan", "Duplikat"],
    labels: ["Bug", "Peningkatan", "Fitur"],
    examples: [
      { title: "Tekan C untuk membuat isu", description: "Buat isu dari mana saja dengan **C** atau tombol Isu baru. Ctrl/⌘+Enter untuk membuatnya.\n\n- [ ] Buat isu pertama Anda\n- [ ] Hapus contoh ini" },
      { title: "Seret kartu ini ke Sedang dikerjakan", description: "Ubah status, penanggung jawab, dan prioritas dengan menyeret di papan, mengklik properti, atau dengan **S**, **A**, **P**." },
      { title: "Buka isu dan sebut rekan dengan @", description: "Klik membuka isu di samping, Enter membuka halaman penuh. Deskripsi dan komentar mendukung daftar, checklist, dan @sebutan — orang yang disebut menerima notifikasi di Kotak masuk." },
    ],
  },
  zh: {
    team: "我的团队",
    statuses: ["待办池", "待处理", "进行中", "审核中", "已完成", "已取消", "重复"],
    labels: ["缺陷", "改进", "功能"],
    examples: [
      { title: "按 C 创建问题", description: "在任何地方按 **C** 或点击“新建问题”即可创建问题。Ctrl/⌘+Enter 完成创建。\n\n- [ ] 创建你的第一个问题\n- [ ] 删除这个示例" },
      { title: "把这张卡片拖到“进行中”", description: "在看板上拖动、点击属性，或按 **S**、**A**、**P**，即可修改状态、负责人和优先级。" },
      { title: "打开问题并用 @ 提及同事", description: "单击在侧边打开问题，按 Enter 打开完整页面。描述和评论支持列表、清单和 @提及——被提及的人会在收件箱收到通知。" },
    ],
  },
  hi: {
    team: "मेरी टीम",
    statuses: ["बैकलॉग", "करना है", "प्रगति में", "समीक्षा में", "पूरा", "रद्द", "डुप्लिकेट"],
    labels: ["बग", "सुधार", "फ़ीचर"],
    examples: [
      { title: "इश्यू बनाने के लिए C दबाएँ", description: "कहीं से भी **C** या नया इश्यू बटन से इश्यू बनाएँ। Ctrl/⌘+Enter से बन जाता है।\n\n- [ ] अपना पहला इश्यू बनाएँ\n- [ ] यह उदाहरण हटाएँ" },
      { title: "इस कार्ड को “प्रगति में” पर खींचें", description: "बोर्ड पर खींचकर, किसी प्रॉपर्टी पर क्लिक करके या **S**, **A**, **P** से स्थिति, ज़िम्मेदार और प्राथमिकता बदलें।" },
      { title: "इश्यू खोलें और @ से किसी साथी का ज़िक्र करें", description: "क्लिक से इश्यू साइड में खुलता है, Enter से पूरे पेज पर। विवरण और टिप्पणियों में सूचियाँ, चेकलिस्ट और @ज़िक्र चलते हैं — जिसका ज़िक्र हो उसे इनबॉक्स में सूचना मिलती है।" },
    ],
  },
  bn: {
    team: "আমার টিম",
    statuses: ["ব্যাকলগ", "করতে হবে", "চলছে", "পর্যালোচনায়", "সম্পন্ন", "বাতিল", "ডুপ্লিকেট"],
    labels: ["বাগ", "উন্নতি", "ফিচার"],
    examples: [
      { title: "ইস্যু তৈরি করতে C চাপুন", description: "যেকোনো জায়গা থেকে **C** বা নতুন ইস্যু বোতাম দিয়ে ইস্যু তৈরি করুন। Ctrl/⌘+Enter চাপলে তৈরি হয়।\n\n- [ ] আপনার প্রথম ইস্যু তৈরি করুন\n- [ ] এই উদাহরণটি মুছুন" },
      { title: "এই কার্ডটি “চলছে”-তে টেনে আনুন", description: "বোর্ডে টেনে, কোনো প্রপার্টিতে ক্লিক করে বা **S**, **A**, **P** দিয়ে স্ট্যাটাস, দায়িত্বপ্রাপ্ত ব্যক্তি ও অগ্রাধিকার বদলান।" },
      { title: "একটি ইস্যু খুলুন এবং @ দিয়ে সহকর্মীকে উল্লেখ করুন", description: "ক্লিক করলে ইস্যু পাশে খোলে, Enter চাপলে পুরো পাতায়। বিবরণ ও মন্তব্যে তালিকা, চেকলিস্ট ও @উল্লেখ চলে — যাকে উল্লেখ করা হয় তিনি ইনবক্সে বিজ্ঞপ্তি পান।" },
    ],
  },
  ar: {
    team: "فريقي",
    statuses: ["قائمة الانتظار", "للتنفيذ", "قيد التنفيذ", "قيد المراجعة", "مكتمل", "ملغى", "مكرر"],
    labels: ["خطأ", "تحسين", "ميزة"],
    examples: [
      { title: "اضغط C لإنشاء مشكلة", description: "أنشئ مشكلة من أي مكان بالضغط على **C** أو زر «مشكلة جديدة». يُنشئها Ctrl/⌘+Enter.\n\n- [ ] أنشئ أول مشكلة لك\n- [ ] احذف هذا المثال" },
      { title: "اسحب هذه البطاقة إلى «قيد التنفيذ»", description: "غيّر الحالة والمسؤول والأولوية بالسحب على اللوحة أو بالنقر على خاصية أو باستخدام **S** و**A** و**P**." },
      { title: "افتح مشكلة واذكر زميلًا باستخدام @", description: "النقر يفتح المشكلة على الجانب، وEnter يفتحها في صفحة كاملة. تدعم الأوصاف والتعليقات القوائم وقوائم المهام والإشارات بـ@ — ويتلقى الشخص المذكور إشعارًا في صندوق الوارد." },
    ],
  },
};

/** The first board's words in this language (English when there are none). */
export function seedFor(locale: string): Seed {
  return S[locale] ?? S.en;
}
