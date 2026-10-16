import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Unit tests are compiled to CommonJS and load modules after setting
  // temp storage paths (see tests/alias.cjs), so require() is intended there.
  {
    files: ["tests/**"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Compiled unit-test output (npm run test:*).
    ".test-dist/**",
    // Vendored builds copied in by prebuild (pdf.js worker).
    "public/vendor/**",
  ]),
]);

export default eslintConfig;
