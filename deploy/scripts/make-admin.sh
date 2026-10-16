#!/usr/bin/env bash
# Moderators (the report queue at /admin).
#   sudo deploy/scripts/make-admin.sh                 list the latest accounts (id, date, name)
#   sudo deploy/scripts/make-admin.sh <id>            make a moderator
#   sudo deploy/scripts/make-admin.sh <id> --remove   take the role away
. "$(dirname "$0")/common.sh"
require_root
load_env
setup_compose
id=${1:-}
if [ -z "$id" ]; then
  compose exec -T web node --no-warnings -e '
const db = new (require("node:sqlite").DatabaseSync)(process.env.ZVENA_DB_PATH, { readOnly: true });
for (const r of db.prepare("SELECT id, name, created_at, is_admin FROM users ORDER BY created_at DESC LIMIT 30").all())
  console.log(`${r.id}  ${new Date(r.created_at).toISOString().slice(0, 10)}  ${r.is_admin ? "[moderator] " : ""}${r.name}`);'
  exit 0
fi
[[ "$id" =~ ^[0-9a-f]{8,64}$ ]] || die "the id is a hexadecimal string from the list"
flag=1
[ "${2:-}" = "--remove" ] && flag=0
compose exec -T web node --no-warnings -e '
const [id, flag] = process.argv.slice(1);
const db = new (require("node:sqlite").DatabaseSync)(process.env.ZVENA_DB_PATH);
const r = db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(Number(flag), id);
if (!r.changes) { console.error("no such account"); process.exit(1); }' "$id" "$flag"
log "done: $id → moderator=$flag"
