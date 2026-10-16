#!/usr/bin/env bash
# The whole of zvena (web app and Design) on this computer, over plain http on
# localhost — to try it or to develop against, not to serve other people.
#   sudo deploy/scripts/local.sh          → http://localhost:3100, Design on :3110
# The first run writes the settings file (fresh secrets, test sign-in on), builds
# the three images from this checkout (30–60 minutes, see build-images.sh) and
# starts them; later runs start what is there. Ports: ZVENA_LOCAL_PORT (web,
# default 3100), the next one for Design and the one after for Design's backend.
# Settings: ZVENA_ENV (default /etc/zvena/local.env). Stop: `docker compose -p
# zvena-local down` (add -v to delete the data too).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
export ZVENA_ENV=${ZVENA_ENV:-/etc/zvena/local.env}
. "$here/common.sh"
require_root
command -v docker >/dev/null || die "Docker is required (docs.docker.com/engine/install)"

if [ ! -e "$ENV_FILE" ]; then
  port=${ZVENA_LOCAL_PORT:-3100}
  [[ "$port" =~ ^[0-9]+$ ]] || die "ZVENA_LOCAL_PORT must be a port number"
  for p in "$port" "$((port + 1))" "$((port + 2))"; do
    if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
      die "port $p is in use on this computer: choose others with ZVENA_LOCAL_PORT=<port>"
    fi
  done
  # Its "next: fill in the domains…" advice is for a server; here this script does it.
  out=$(bash "$here/init-env.sh") || exit 1
  printf '%s\n' "$out" | grep -v -e '^Next:' -e '^  your legal pages' -e '^Another zvena' -e '^  and needs its own ports' || true
  load_env
  # A local copy is a test server: a banner on every page, nothing indexed, the
  # test sign-in ("Sign in as a test user"), letters kept as files instead of sent.
  set_env COMPOSE_PROJECT_NAME zvena-local
  set_env ZVENA_STAND test
  set_env ZVENA_DEV_LOGIN 1
  set_env ZVENA_MAIL_OUTBOX /data/outbox
  set_env APP_URL "http://localhost:$port"
  set_env DESIGN_URL "http://localhost:$((port + 1))"
  set_env WEB_PORT "$port"
  set_env DESIGN_PORT "$((port + 1))"
  set_env DESIGN_BACKEND_PORT "$((port + 2))"
  # Design's session cookies over plain http (refused by up.sh in production).
  set_env DESIGN_EXTRA_FLAGS "disable-secure-session-cookies"
  rm -f "$ENV_FILE.prev"
  log "settings for this computer: $ENV_FILE (backup passphrase: $BACKUP_PASSPHRASE_FILE)"
fi
load_env
[ "${ZVENA_STAND:-}" = test ] || die "$ENV_FILE is not a local (test) settings file: use up.sh for a server"

missing=0
for k in WEB_IMAGE DESIGN_BACKEND_IMAGE DESIGN_FRONTEND_IMAGE; do
  if [ -z "${!k:-}" ] || ! docker image inspect "${!k}" >/dev/null 2>&1; then missing=1; fi
done
if [ "$missing" = 1 ]; then
  log "building the images from this checkout (the first time takes 30–60 minutes)…"
  bash "$here/build-images.sh"
fi
bash "$here/up.sh"
load_env
log "open $APP_URL and choose \"Sign in as a test user\"; Design: $DESIGN_URL"
