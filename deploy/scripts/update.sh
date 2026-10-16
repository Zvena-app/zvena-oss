#!/usr/bin/env bash
# Updates zvena from Git: backup → git pull → build the images → restart.
#   sudo deploy/scripts/update.sh                    build here
#   sudo deploy/scripts/update.sh --images <archive>  images built elsewhere (save-images.sh)
# Rollback: the previous image tags stay in $ENV_FILE.prev —
#   cp /etc/zvena/zvena.env.prev /etc/zvena/zvena.env && deploy/scripts/up.sh
# (and restore.sh if the data must go back too).
. "$(dirname "$0")/common.sh"
require_root
load_env
log "backup before the update"
"$DEPLOY/scripts/backup.sh"
log "git pull"
git -C "$ZVENA_DIR" pull --ff-only
cp -p "$ENV_FILE" "$ENV_FILE.before-update"
if [ "${1:-}" = "--images" ]; then
  "$DEPLOY/scripts/load-images.sh" "${2:?image archive}"
else
  "$DEPLOY/scripts/build-images.sh"
fi
cp -p "$ENV_FILE.before-update" "$ENV_FILE.prev"
"$DEPLOY/scripts/up.sh"
log "updated to $(git -C "$ZVENA_DIR" rev-parse --short HEAD)"
