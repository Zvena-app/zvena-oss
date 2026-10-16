#!/usr/bin/env bash
# An encrypted backup of everything people store in zvena:
#   penpot.dump   Design's PostgreSQL (pg_dump, custom format)
#   zvena.db      the web app's SQLite (a consistent copy: VACUUM INTO)
#   files.tar     uploads of Docs
#   assets.tar    Design's files (skipped with S3 — use the bucket's versioning
#                 and replication there)
#   manifest.txt  versions, sizes, sha256
# packed into BACKUP_DIR/zvena-<UTC time>.tar.gpg (AES-256, the passphrase
# from BACKUP_PASSPHRASE_FILE), copies older than BACKUP_KEEP_DAYS removed,
# then copied to BACKUP_RSYNC_TARGET and/or BACKUP_RCLONE_REMOTE.
#   sudo deploy/scripts/backup.sh          (cron: daily, see DEPLOY.md)
. "$(dirname "$0")/common.sh"
require_root
load_env
setup_compose
command -v gpg >/dev/null || die "gpg is required (apt install gnupg)"
[ -r "${BACKUP_PASSPHRASE_FILE:-}" ] || die "no passphrase file BACKUP_PASSPHRASE_FILE"
dir=${BACKUP_DIR:-/var/backups/zvena}
install -d -m 700 "$dir"
stamp=$(date -u +%Y%m%d-%H%M%S)
work=$(mktemp -d "$dir/.work-XXXX")
trap 'rm -rf "$work"' EXIT

log "PostgreSQL"
compose exec -T postgres pg_dump -U penpot -d penpot -Fc > "$work/penpot.dump"
log "SQLite"
compose exec -T web node --no-warnings -e '
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const out = "/data/.backup.db";
fs.rmSync(out, { force: true });
new DatabaseSync(process.env.ZVENA_DB_PATH).exec(`VACUUM INTO \x27${out}\x27`);'
compose exec -T web cat /data/.backup.db > "$work/zvena.db"
compose exec -T web rm -f /data/.backup.db
log "Docs files"
compose exec -T web sh -c 'cd /data && if [ -d files ]; then tar -cf - files; else tar -cf - --files-from /dev/null; fi' > "$work/files.tar"
if [ -z "${S3_BUCKET:-}" ]; then
  log "Design files"
  compose exec -T design-backend sh -c 'cd /opt/data && tar -cf - assets' > "$work/assets.tar"
fi
{
  echo "zvena backup $stamp"
  echo "git $(git -C "$ZVENA_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "images $WEB_IMAGE $DESIGN_BACKEND_IMAGE $DESIGN_FRONTEND_IMAGE"
  (cd "$work" && for f in penpot.dump zvena.db files.tar assets.tar; do [ -f "$f" ] && echo "$(sha256sum "$f" | cut -d' ' -f1) $(stat -c %s "$f") $f"; done)
} > "$work/manifest.txt"
out="$dir/zvena-$stamp.tar.gpg"
tar -C "$work" -cf - manifest.txt penpot.dump zvena.db files.tar $( [ -f "$work/assets.tar" ] && echo assets.tar ) \
  | gpg --batch --yes --quiet --symmetric --cipher-algo AES256 --pinentry-mode loopback --passphrase-file "$BACKUP_PASSPHRASE_FILE" -o "$out.part"
mv "$out.part" "$out"
chmod 600 "$out"
log "backup: $out ($(du -h "$out" | cut -f1))"

find "$dir" -maxdepth 1 -name 'zvena-*.tar.gpg' -mtime +"${BACKUP_KEEP_DAYS:-14}" -print -delete | sed 's/^/removed old backup: /'
if [ -n "${BACKUP_RSYNC_TARGET:-}" ]; then
  log "copying off-site (rsync)"
  rsync -a --delete --include 'zvena-*.tar.gpg' --exclude '*' "$dir/" "$BACKUP_RSYNC_TARGET/"
fi
if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
  log "copying off-site (rclone)"
  rclone sync --include 'zvena-*.tar.gpg' "$dir" "$BACKUP_RCLONE_REMOTE"
fi
date -u +%s > "$dir/.last-ok"
log "backup finished"
