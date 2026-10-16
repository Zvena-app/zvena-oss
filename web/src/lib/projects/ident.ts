// Team keys (the ZVN of ZVN-123): suggested from a team name in any
// alphabet, validated, and issue identifiers parsed. Pure.

import { IDENTIFIER_RE, TEAM_KEY_RE } from "./types";

const TRANSLIT: Record<string, string> = {
  а: "A", б: "B", в: "V", г: "G", д: "D", е: "E", ё: "E", ж: "ZH", з: "Z", и: "I", й: "Y", к: "K", л: "L", м: "M", н: "N", о: "O", п: "P", р: "R", с: "S", т: "T", у: "U", ф: "F", х: "KH", ц: "TS", ч: "CH", ш: "SH", щ: "SCH", ъ: "", ы: "Y", ь: "", э: "E", ю: "YU", я: "YA",
  і: "I", ї: "YI", є: "YE", ґ: "G",
};

export function translit(s: string): string {
  return [...s.toLowerCase()].map((c) => TRANSLIT[c] ?? c.toUpperCase()).join("");
}

/** "Мобильное приложение" → "MP", "Platform" → "PLA", "zvena" → "ZVE". */
export function suggestKey(name: string): string {
  const words = translit(name)
    .replace(/[^A-Z0-9 ]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let key = words.length > 1 ? words.map((w) => w[0]).join("").slice(0, 4) : (words[0] ?? "").slice(0, 3);
  key = key.replace(/^[0-9]+/, "");
  return TEAM_KEY_RE.test(key) ? key : "TEAM";
}

export function isTeamKey(v: unknown): v is string {
  return typeof v === "string" && TEAM_KEY_RE.test(v);
}

export function parseIdentifier(v: string): { key: string; number: number } | null {
  const m = IDENTIFIER_RE.exec(v.trim());
  return m ? { key: m[1].toUpperCase(), number: Number(m[2]) } : null;
}
