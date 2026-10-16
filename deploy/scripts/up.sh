#!/usr/bin/env bash
# Starts (or updates to the images in the settings file) the whole service
# and waits until the health check passes.
#   sudo deploy/scripts/up.sh
. "$(dirname "$0")/common.sh"
require_root
load_env
setup_compose
for k in APP_URL DESIGN_URL AUTH_SECRET PG_PASSWORD DESIGN_SECRET_KEY DESIGN_MGMT_KEY DESIGN_OIDC_CLIENT_SECRET ZVENA_INTERNAL_KEY WEB_IMAGE DESIGN_BACKEND_IMAGE DESIGN_FRONTEND_IMAGE; do
  [ -n "${!k:-}" ] || die "$k is not set in $ENV_FILE"
done
compose up -d --remove-orphans
log "waiting until healthy…"
wait_healthy || { compose ps; die "the service did not become healthy within 5 minutes: compose logs --tail 100 web design-backend"; }
log "running: $APP_URL"
