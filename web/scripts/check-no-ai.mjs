// Jev is zvena's AI; other providers are not allowed. Scans the web app and the
// Design fork (sources, package manifests, the env example) for other AI
// provider hosts, SDKs and key names; exits 1 on a hit.
//   node scripts/check-no-ai.mjs
//
// Jev (TypeSafe AI's decision model) is reached through web/src/lib/decide/jev.ts
// only: server-side, on in every workspace once TYPESAFE_API_KEY is set (an
// owner can turn it off), and given only the fields a question names. A Jev
// call or key anywhere else is a hit too.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SCAN = ["web/src", "web/package.json", "web/next.config.ts", "deploy", "design/src/frontend/src", "design/src/frontend/package.json", "design/src/backend/src", "design/src/backend/deps.edn", "design/src/exporter/src", "design/src/common/src"];
const SKIP_DIR = new Set(["node_modules", ".next", "target", "resources", "translations"]);
const EXT = /\.(ts|tsx|js|mjs|cjs|cljs|cljc|clj|edn|json|ya?ml|env|example|sh|conf)$/;
const RULES = [
  [/api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis|aiplatform\.googleapis|api\.mistral\.ai|api\.groq\.com|openrouter\.ai|api\.deepseek\.com|api\.x\.ai|llm\.api\.cloud\.yandex|gigachat/i, "AI provider host"],
  [/["'](openai|@anthropic-ai\/[\w-]+|@google\/genai|@google\/generative-ai|ai|@ai-sdk\/[\w-]+|langchain|@langchain\/[\w-]+|@modelcontextprotocol\/[\w-]+)["']\s*[:)]/, "AI SDK dependency or import"],
  [/\b(OPENAI|ANTHROPIC|GEMINI|MISTRAL|GROQ|DEEPSEEK|OPENROUTER|GIGACHAT|YANDEXGPT)_API_KEY\b/, "AI key name"],
  [/api\.typesafe\.ai|@typesafe-ai\/sdk|\bTYPESAFE_API_KEY\b/, "Jev (TypeSafe AI) outside its one module"],
  // Design's UI keys with the legacy blueai.* prefix are layout, not AI; an
  // assistant built on them must not come back.
  [/\b(ai-assistant|aiAssistant|ai-plugin|blueai-ai|workspace\.blueai|blueai\.ai\.|ai\.blueai)\b|ai-panel|toggle-ai|open-ai-|:ai-chat/i, "leftover assistant code"],
];

// Files allowed to name Jev (see the header).
const JEV_ALLOWED = new Set(["web/src/lib/decide/jev.ts", "web/scripts/check-no-ai.mjs", "deploy/.env.example", "deploy/docker-compose.yml"]);

const hits = [];
function scan(path) {
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) if (!SKIP_DIR.has(name)) scan(join(path, name));
    return;
  }
  if (!EXT.test(path) && !path.endsWith("env.example")) return;
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const [re, what] of RULES) if (re.test(line) && !(what.startsWith("Jev") && JEV_ALLOWED.has(relative(root, path)))) hits.push(`${relative(root, path)}:${i + 1}  ${what}: ${line.trim().slice(0, 140)}`);
  });
}
for (const p of SCAN) scan(join(root, p));
if (hits.length) {
  console.log(hits.join("\n"));
  console.log(`\n${hits.length} AI traces found`);
  process.exit(1);
}
console.log("no AI traces: providers, SDKs and keys are absent (Jev only in web/src/lib/decide/jev.ts)");
