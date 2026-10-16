// zvena's one AI is an optional decision model (an RLHF architecture and model)
// for smart suggestions and automations; other providers are not allowed. Scans
// the web app and the Design fork (sources, package manifests, the env example)
// for other AI provider hosts, SDKs and key names; exits 1 on a hit.
//   node scripts/check-no-ai.mjs
//
// The decision model is reached through web/src/lib/decide/smart.ts only:
// server-side, off unless ZVENA_AI_URL and ZVENA_AI_KEY are both set (then on
// in every workspace; an owner can turn it off), and given only the fields a
// question names. Its endpoint or key anywhere else is a hit too.
//
// The model's provider and its former internal name stay out of the product:
// a name rule (spelled with character classes so this file does not match
// itself) fails on them in the sources, tests, scripts and docs. The one
// exception is web/src/lib/legacy-names.ts, which maps values stored by
// earlier releases.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SCAN = ["web/src", "web/package.json", "web/next.config.ts", "deploy", "design/src/frontend/src", "design/src/frontend/package.json", "design/src/backend/src", "design/src/backend/deps.edn", "design/src/exporter/src", "design/src/common/src"];
// Scanned for the name rule only.
const NAME_SCAN = ["web/tests", "web/scripts", "web/public", "README.md", "DEPLOY.md", "PROJECTS.md", "ROADMAP.md", "GOVERNANCE.md", "CONTRIBUTING.md", "SECURITY.md", "web/src/lib/decide/README.md"];
const SKIP_DIR = new Set(["node_modules", ".next", ".test-dist", "target", "resources", "translations"]);
const EXT = /\.(ts|tsx|js|mjs|cjs|cljs|cljc|clj|edn|json|ya?ml|env|example|sh|conf|css|md|html|txt|svg)$/;
const NAME = [/j[e]v|t[y]pe-?s[a]fe/i, "the decision model's provider or former name"];
const RULES = [
  [/api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis|aiplatform\.googleapis|api\.mistral\.ai|api\.groq\.com|openrouter\.ai|api\.deepseek\.com|api\.x\.ai|llm\.api\.cloud\.yandex|gigachat/i, "AI provider host"],
  [/["'](openai|@anthropic-ai\/[\w-]+|@google\/genai|@google\/generative-ai|ai|@ai-sdk\/[\w-]+|langchain|@langchain\/[\w-]+|@modelcontextprotocol\/[\w-]+)["']\s*[:)]/, "AI SDK dependency or import"],
  [/\b(OPENAI|ANTHROPIC|GEMINI|MISTRAL|GROQ|DEEPSEEK|OPENROUTER|GIGACHAT|YANDEXGPT)_API_KEY\b/, "AI key name"],
  [/\bZVENA_AI_(URL|KEY)\b/, "the decision model outside its one module"],
  // Design's UI keys with the legacy blueai.* prefix are layout, not AI; an
  // assistant built on them must not come back.
  [/\b(ai-assistant|aiAssistant|ai-plugin|blueai-ai|workspace\.blueai|blueai\.ai\.|ai\.blueai)\b|ai-panel|toggle-ai|open-ai-|:ai-chat/i, "leftover assistant code"],
  NAME,
];

// Files allowed to name the decision model's endpoint and key (see the header; docs may too).
const MODEL_ALLOWED = new Set(["web/src/lib/decide/smart.ts", "web/scripts/check-no-ai.mjs", "deploy/.env.example", "deploy/docker-compose.yml"]);
// The one file allowed to spell legacy stored values.
const NAME_ALLOWED = new Set(["web/src/lib/legacy-names.ts"]);

const hits = [];
function scan(path, rules) {
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) if (!SKIP_DIR.has(name)) scan(join(path, name), rules);
    return;
  }
  if (!EXT.test(path) && !path.endsWith("env.example")) return;
  const rel = relative(root, path);
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const [re, what] of rules) {
      if (!re.test(line)) continue;
      if (what.startsWith("the decision model outside") && (MODEL_ALLOWED.has(rel) || rel.endsWith(".md"))) continue;
      if (what === NAME[1] && NAME_ALLOWED.has(rel)) continue;
      hits.push(`${rel}:${i + 1}  ${what}: ${line.trim().slice(0, 140)}`);
    }
  });
}
for (const p of SCAN) scan(join(root, p), RULES);
for (const p of NAME_SCAN) scan(join(root, p), [NAME]);
if (hits.length) {
  console.log(hits.join("\n"));
  console.log(`\n${hits.length} AI traces found`);
  process.exit(1);
}
console.log("no AI traces: providers, SDKs and keys are absent (the decision model only in web/src/lib/decide/smart.ts)");
