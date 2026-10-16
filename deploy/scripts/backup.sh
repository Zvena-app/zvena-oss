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
# then new archives copied (never mirrored) to BACKUP_RSYNC_TARGET and/or
# BACKUP_RCLONE_REMOTE; off-site copies older than BACKUP_REMOTE_KEEP_DAYS
# (default 30; 0 = keep forever) are pruned after a good run.
#   sudo deploy/scripts/backup.sh          (cron: daily, see DEPLOY.md)
. "$(dirname "$0")/common.sh"
require_root
load_env
setup_compose
command -v gpg >/dev/null || die "gpg is required (apt install gnupg)"
[ -r "${BACKUP_PASSPHRASE_FILE:-}" ] || die "no passphrase file BACKUP_PASSPHRASE_FILE"
dir=${BACKUP_DIR:-/var/backups/zvena}
install -d -m 700 "$dir"
# One folder per instance: old archives are pruned and .last-ok (monitor.sh) is
# written per folder, so a stand must not back up into production's.
instance=${COMPOSE_PROJECT_NAME:-zvena}
if [ -s "$dir/.instance" ] && [ "$(cat "$dir/.instance")" != "$instance" ]; then
  die "$dir holds the backups of \"$(cat "$dir/.instance")\", not \"$instance\": set BACKUP_DIR in $ENV_FILE"
fi
[ -s "$dir/.instance" ] || echo "$instance" > "$dir/.instance"
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
parts=(manifest.txt penpot.dump zvena.db files.tar)
if [ -f "$work/assets.tar" ]; then parts+=(assets.tar); fi
tar -C "$work" -cf - "${parts[@]}" \
  | gpg --batch --yes --quiet --symmetric --cipher-algo AES256 --pinentry-mode loopback --passphrase-file "$BACKUP_PASSPHRASE_FILE" -o "$out.part"
mv "$out.part" "$out"
chmod 600 "$out"
log "backup: $out ($(du -h "$out" | cut -f1))"

find "$dir" -maxdepth 1 -name 'zvena-*.tar.gpg' -mtime +"${BACKUP_KEEP_DAYS:-14}" -print -delete | sed 's/^/removed old backup: /'

# Off-site: new archives are only ever ADDED (never mirrored, never
# overwritten), so an emptied or encrypted local folder cannot wipe the remote
# copies. Old remote copies are pruned separately, by the date in their name,
# and only now that today's backup has been written and copied.
remote_days=${BACKUP_REMOTE_KEEP_DAYS:-30}
[[ "$remote_days" =~ ^[0-9]+$ ]] || die "BACKUP_REMOTE_KEEP_DAYS must be a number of days (0 = never prune)"
cutoff=$(date -u -d "-$remote_days days" +%Y%m%d)
# Archive names whose date is before the cutoff (never today's archive).
old_names() {
  { grep -oE 'zvena-[0-9]{8}-[0-9]{6}\.tar\.gpg' || true; } | sort -u | while read -r name; do
    [ "$name" = "$(basename "$out")" ] && continue
    [ "${name:6:8}" -lt "$cutoff" ] && echo "$name"
  done
  return 0
}
if [ -n "${BACKUP_RSYNC_TARGET:-}" ]; then
  log "copying off-site (rsync)"
  rsync -a --ignore-existing --include 'zvena-*.tar.gpg' --exclude '*' "$dir/" "$BACKUP_RSYNC_TARGET/"
  if [ "$remote_days" -gt 0 ]; then
    list="$work/rsync-old.txt"
    rsync --list-only "$BACKUP_RSYNC_TARGET/" | awk '{print $NF}' | old_names > "$list"
    if [ -s "$list" ]; then
      # Deletes exactly the listed names: the source is an empty folder and
      # everything not listed is excluded (protected) from deletion.
      install -d -m 700 "$work/empty"
      if rsync -r --delete --include-from="$list" --exclude '*' "$work/empty/" "$BACKUP_RSYNC_TARGET/"; then
        sed 's/^/removed old off-site backup: /' "$list"
      else
        log "warning: old off-site copies were not pruned (rsync)"
      fi
    fi
  fi
fi
if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
  log "copying off-site (rclone)"
  rclone copy --immutable --max-depth 1 --include 'zvena-*.tar.gpg' "$dir" "$BACKUP_RCLONE_REMOTE"
  if [ "$remote_days" -gt 0 ]; then
    list="$work/rclone-old.txt"
    rclone lsf --max-depth 1 --files-only --include 'zvena-*.tar.gpg' "$BACKUP_RCLONE_REMOTE" | old_names > "$list"
    if [ -s "$list" ]; then
      # A bucket with object lock may refuse: that is fine, it only logs.
      if rclone delete --max-depth 1 --files-from-raw "$list" "$BACKUP_RCLONE_REMOTE"; then
        sed 's/^/removed old off-site backup: /' "$list"
      else
        log "warning: old off-site copies were not pruned (rclone)"
      fi
    fi
  fi
fi
date -u +%s > "$dir/.last-ok"
log "backup finished"
