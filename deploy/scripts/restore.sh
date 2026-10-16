#!/usr/bin/env bash
# Restores a backup from backup.sh into this server's zvena — everything
# stored now is REPLACED by the copy. Asks for confirmation.
#   sudo deploy/scripts/restore.sh /var/backups/zvena/zvena-<time>.tar.gpg [--yes] [--i-have-no-backup]
# Before anything is replaced, a fresh backup of the current state is made.
# When that fails (e.g. the service is down), nothing is touched: the script
# asks (or, with --yes, stops) — only --i-have-no-backup goes on without one.
. "$(dirname "$0")/common.sh"
require_root
load_env
setup_compose
src=${1:?backup file .tar.gpg}
shift
yes=0
no_backup=0
for a in "$@"; do
  case "$a" in
    --yes) yes=1 ;;
    --i-have-no-backup) no_backup=1 ;;
    *) die "unknown option $a" ;;
  esac
done
[ -r "$src" ] || die "no file $src"
[ -r "${BACKUP_PASSPHRASE_FILE:-}" ] || die "no passphrase file BACKUP_PASSPHRASE_FILE"
work=$(mktemp -d "${TMPDIR:-/tmp}/zvena-restore-XXXX")
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"

gpg --batch --quiet --decrypt --pinentry-mode loopback --passphrase-file "$BACKUP_PASSPHRASE_FILE" "$src" | tar -C "$work" -xf -
[ -f "$work/manifest.txt" ] || die "the archive has no manifest.txt"
log "checking checksums"
tail -n +4 "$work/manifest.txt" | while read -r sum _size f; do
  [ "$(sha256sum "$work/$f" | cut -d' ' -f1)" = "$sum" ] || die "$f is damaged"
done
head -3 "$work/manifest.txt"

if [ "$yes" != 1 ]; then
  echo
  echo "ALL CURRENT zvena DATA will be replaced by this backup."
  read -r -p "Type RESTORE to continue: " ok
  [ "$ok" = "RESTORE" ] || die "cancelled"
fi

log "first, a backup of the current state"
if ! "$DEPLOY/scripts/backup.sh"; then
  # Nothing has been touched yet. Going on would delete the only copy of
  # what is stored now, so --yes alone never does.
  if [ "$no_backup" = 1 ]; then
    log "warning: no backup of the current state (--i-have-no-backup): it is lost if this restore is wrong"
  elif [ "$yes" = 1 ]; then
    die "could not back up the current state — nothing was changed (fix the backup, or pass --i-have-no-backup to restore without one)"
  else
    read -r -p "Could not back up the current state; it will be LOST. Type NO-BACKUP to continue anyway: " ok
    [ "$ok" = "NO-BACKUP" ] || die "cancelled — nothing was changed"
  fi
fi

log "stopping the app"
compose stop web design-frontend design-exporter design-backend

log "PostgreSQL"
compose up -d postgres
for _ in $(seq 1 30); do compose exec -T postgres pg_isready -U penpot -d penpot >/dev/null 2>&1 && break; sleep 2; done
compose exec -T postgres psql -U penpot -d postgres -q -c 'DROP DATABASE IF EXISTS penpot WITH (FORCE)' -c 'CREATE DATABASE penpot OWNER penpot'
# All or nothing: a dump that does not load stops here, with the safety backup above to go back to.
compose exec -T postgres pg_restore -U penpot -d penpot --no-owner --role=penpot --exit-on-error --single-transaction < "$work/penpot.dump" \
  || die "PostgreSQL did not restore (the app is stopped) — restore the backup made a moment ago (newest in ${BACKUP_DIR:-/var/backups/zvena})"

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
