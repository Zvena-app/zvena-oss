// The native apps' few words in zvena's interface languages: Android
// values-<lang>/strings.xml and iOS <lang>.lproj/Localizable.strings
// (the share extension). English is the default. Run: node scripts/strings.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** share: the share sheet's label (and the extension's name); saving / opening / empty: the iOS share extension's states. */
const S = {
  en: { share: "Save to zvena", saving: "Saving to zvena…", opening: "Opening zvena…", empty: "Nothing to save here: share a link or text." },
  zh: { share: "保存到 zvena", saving: "正在保存到 zvena…", opening: "正在打开 zvena…", empty: "这里没有可保存的内容：请分享链接或文本。" },
  hi: { share: "zvena में सहेजें", saving: "zvena में सहेजा जा रहा है…", opening: "zvena खुल रहा है…", empty: "यहाँ सहेजने के लिए कुछ नहीं है: कोई लिंक या टेक्स्ट साझा करें।" },
  es: { share: "Guardar en zvena", saving: "Guardando en zvena…", opening: "Abriendo zvena…", empty: "No hay nada que guardar: comparte un enlace o un texto." },
  ar: { share: "حفظ في zvena", saving: "جارٍ الحفظ في zvena…", opening: "جارٍ فتح zvena…", empty: "لا يوجد ما يُحفظ هنا: شارك رابطًا أو نصًا." },
  fr: { share: "Enregistrer dans zvena", saving: "Enregistrement dans zvena…", opening: "Ouverture de zvena…", empty: "Rien à enregistrer ici : partagez un lien ou un texte." },
  bn: { share: "zvena-তে সংরক্ষণ করুন", saving: "zvena-তে সংরক্ষণ করা হচ্ছে…", opening: "zvena খোলা হচ্ছে…", empty: "এখানে সংরক্ষণ করার কিছু নেই: একটি লিঙ্ক বা লেখা শেয়ার করুন।" },
  pt: { share: "Salvar no zvena", saving: "Salvando no zvena…", opening: "Abrindo o zvena…", empty: "Nada para salvar aqui: compartilhe um link ou um texto." },
  ru: { share: "Сохранить в zvena", saving: "Сохраняем в zvena…", opening: "Открываем zvena…", empty: "Здесь нечего сохранить: поделитесь ссылкой или текстом." },
  id: { share: "Simpan ke zvena", saving: "Menyimpan ke zvena…", opening: "Membuka zvena…", empty: "Tidak ada yang bisa disimpan: bagikan tautan atau teks." },
};

const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/'/g, "\\'").replace(/"/g, '\\"');
const strings = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

// Android: Indonesian is "in" (the platform's legacy code); English lives in values/.
const androidDir = { en: "values", id: "values-in" };
for (const [lang, t] of Object.entries(S)) {
  const dir = join(root, "android/app/src/main/res", androidDir[lang] ?? `values-${lang}`);
  mkdirSync(dir, { recursive: true });
  const base = lang === "en"
    ? `    <string name="app_name">zvena</string>\n    <string name="title_activity_main">zvena</string>\n    <string name="package_name">app.zvena.mobile</string>\n    <string name="custom_url_scheme">zvena</string>\n`
    : "";
  writeFileSync(join(dir, "strings.xml"), `<?xml version="1.0" encoding="utf-8"?>\n<!-- Written by scripts/strings.mjs. -->\n<resources>\n${base}    <string name="share_label">${xml(t.share)}</string>\n</resources>\n`);
}

for (const [lang, t] of Object.entries(S)) {
  const dir = join(root, "ios/App/ShareExtension", `${lang === "zh" ? "zh-Hans" : lang}.lproj`);
  mkdirSync(dir, { recursive: true });
  const body = Object.entries(t).map(([k, v]) => `"${k}" = "${strings(v)}";`).join("\n");
  writeFileSync(join(dir, "Localizable.strings"), `/* Written by scripts/strings.mjs. */\n${body}\n`);
  // The extension's name under the share sheet's icon.
  writeFileSync(join(dir, "InfoPlist.strings"), `/* Written by scripts/strings.mjs. */\n"CFBundleDisplayName" = "${strings(t.share)}";\n`);
}
console.log(`strings for ${Object.keys(S).length} languages written`);
