#!/usr/bin/env bash
# Restores a backup from backup.sh into this server's zvena — everything
# stored now is REPLACED by the copy. Asks for confirmation.
#   sudo deploy/scripts/restore.sh /var/backups/zvena/zvena-<time>.tar.gpg [--yes]
# Before replacing, a fresh backup of the current state is made (unless the
# service is down and that fails — then it asks again).
. "$(dirname "$0")/common.sh"
require_root
load_env
setup_compose
src=${1:?backup file .tar.gpg}
[ -r "$src" ] || die "no file $src"
[ -r "${BACKUP_PASSPHRASE_FILE:-}" ] || die "no passphrase file BACKUP_PASSPHRASE_FILE"
work=$(mktemp -d "${TMPDIR:-/tmp}/zvena-restore-XXXX")
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"

gpg --batch --quiet --decrypt --pinentry-mode loopback --passphrase-file "$BACKUP_PASSPHRASE_FILE" "$src" | tar -C "$work" -xf -
[ -f "$work/manifest.txt" ] || die "the archive has no manifest.txt"
log "checking checksums"
tail -n +4 "$work/manifest.txt" | while read -r sum size f; do
  [ "$(sha256sum "$work/$f" | cut -d' ' -f1)" = "$sum" ] || die "$f is damaged"
done
head -3 "$work/manifest.txt"

if [ "${2:-}" != "--yes" ]; then
  echo
  echo "ALL CURRENT zvena DATA will be replaced by this backup."
  read -r -p "Type RESTORE to continue: " ok
  [ "$ok" = "RESTORE" ] || die "cancelled"
fi

log "first, a backup of the current state"
if ! "$DEPLOY/scripts/backup.sh"; then
  [ "${2:-}" = "--yes" ] || { read -r -p "Could not back up the current state. Continue anyway? (yes/no) " ok; [ "$ok" = "yes" ] || die "cancelled"; }
fi

log "stopping the app"
compose stop web design-frontend design-exporter design-backend

log "PostgreSQL"
compose up -d postgres
for i in $(seq 1 30); do compose exec -T postgres pg_isready -U penpot -d penpot >/dev/null 2>&1 && break; sleep 2; done
compose exec -T postgres psql -U penpot -d postgres -q -c 'DROP DATABASE IF EXISTS penpot WITH (FORCE)' -c 'CREATE DATABASE penpot OWNER penpot'
compose exec -T postgres pg_restore -U penpot -d penpot --no-owner --role=penpot < "$work/penpot.dump"

log "SQLite and Docs files"
compose run --rm --no-deps -T --entrypoint sh web -c 'rm -rf /data/files /data/zvena.db /data/zvena.db-wal /data/zvena.db-shm && cat > /data/zvena.db' < "$work/zvena.db"
compose run --rm --no-deps -T --entrypoint sh web -c 'cd /data && tar -xf -' < "$work/files.tar"
if [ -f "$work/assets.tar" ]; then
  log "Design files"
  compose run --rm --no-deps -T --entrypoint sh design-backend -c 'rm -rf /opt/data/assets/* && cd /opt/data && tar -xf -' < "$work/assets.tar"
fi

log "starting"
compose up -d
wait_healthy || die "the service did not become healthy after the restore — check compose logs"
log "restored from $(basename "$src")"
