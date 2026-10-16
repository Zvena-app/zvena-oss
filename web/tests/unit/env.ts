// Imported first by every unit test: all storage goes to a fresh temporary
// directory (never the stand's or production paths), no Design, no mail.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "zvena-unit-"));
Object.assign(process.env, {
  ZVENA_DB_PATH: join(dir, "zvena.db"),
  ZVENA_FILES_DIR: join(dir, "files"),
  ZVENA_MAIL_OUTBOX: join(dir, "outbox"),
  AUTH_SECRET: randomBytes(32).toString("hex"),
  APP_URL: "http://localhost:3100",
  DESIGN_URL: "http://localhost:3110",
  ZVENA_CONSENT_VERSION: "2026-10-13",
  ZVENA_MAINTENANCE: "off",
  ZVENA_MAX_WORKSPACES: "3",
});
for (const k of ["PENPOT_MGMT_URL", "PENPOT_MGMT_KEY", "SMTP_HOST", "ZVENA_ADMIN_IDS", "ZVENA_STAND", "ZVENA_DEV_LOGIN"]) delete process.env[k];

export const TEST_DIR = dir;
