#!/usr/bin/env bash
# Builds the three zvena images from this Git checkout and writes their tags
# into the settings file (WEB_IMAGE, DESIGN_BACKEND_IMAGE, DESIGN_FRONTEND_IMAGE).
#   sudo deploy/scripts/build-images.sh
# Needs Docker, git, python3, rsync and for Design's frontend ~8 GB RAM,
# ~15 GB of disk and 30–60 minutes (Penpot's build image penpotapp/devenv).
# The working files go to ZVENA_BUILD_DIR (default /var/lib/zvena-build).
. "$(dirname "$0")/common.sh"
require_root
load_env
export ZVENA_BUILD_DIR=${ZVENA_BUILD_DIR:-/var/lib/zvena-build}
mkdir -p "$ZVENA_BUILD_DIR"
cd "$ZVENA_DIR" || exit 1
[ -z "$(git status --porcelain -- .)" ] || die "there are uncommitted changes: images are built from a commit only"
ver=$(git rev-parse --short HEAD)

log "Design: backend"
backend=$(bash design/bin/build-backend.sh | tail -1)
log "Design: frontend (takes a while)"
bash design/bin/build-frontend.sh --release
frontend=$(bash design/bin/build-frontend-image.sh | tail -1)
log "the \"Source code\" page (MPL 2.0)"
bash design/bin/publish-source.sh >/dev/null
log "web"
web="zvena-web:$ver"
docker build -q -f deploy/web.Dockerfile -t "$web" web >/dev/null

set_env DESIGN_BACKEND_IMAGE "$backend"
set_env DESIGN_FRONTEND_IMAGE "$frontend"
set_env WEB_IMAGE "$web"
log "done: $web, $backend, $frontend (previous settings: $ENV_FILE.prev)"
