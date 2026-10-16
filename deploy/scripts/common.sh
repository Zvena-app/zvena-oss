# shellcheck shell=bash
# Shared bits of the zvena server scripts (sourced, not run).
#   ZVENA_ENV=/etc/zvena/zvena.env   the settings file (default)
# The settings file is parsed line by line (KEY=VALUE, optional double quotes)
# and never executed. Secrets are never printed.

set -euo pipefail
DEPLOY=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck disable=SC2034 # used by the scripts that source this file
ZVENA_DIR=$(cd "$DEPLOY/.." && pwd)
# The scripts run as root (sudo) in a checkout that usually belongs to the person
# who cloned it; git refuses such a repository ("dubious ownership") unless told
# it is trusted. These scripts come from this checkout, so trusting it adds nothing.
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$ZVENA_DIR"
ENV_FILE=${ZVENA_ENV:-/etc/zvena/zvena.env}

die() { echo "error: $*" >&2; exit 1; }
log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

load_env() {
  [ -r "$ENV_FILE" ] || die "no settings file $ENV_FILE (run scripts/init-env.sh first)"
  local line k v
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    k=${BASH_REMATCH[1]}
    v=${BASH_REMATCH[2]}
    if [[ "$v" =~ ^\"(.*)\"$ ]]; then v=${BASH_REMATCH[1]}; fi
    export "$k=$v"
  done < "$ENV_FILE"
}

# Sets KEY=VALUE in the settings file (a copy of the previous file is kept).
set_env() {
  local k=$1 v=$2
  cp -p "$ENV_FILE" "$ENV_FILE.prev"
  if grep -q "^$k=" "$ENV_FILE"; then
    local tmp
    tmp=$(mktemp "$ENV_FILE.XXXX")
    awk -v k="$k" -v v="$v" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' "$ENV_FILE" > "$tmp"
    chmod --reference="$ENV_FILE" "$tmp"
    mv "$tmp" "$ENV_FILE"
  else
    echo "$k=$v" >> "$ENV_FILE"
  fi
  export "$k=$v"
}

# The test stand (ZVENA_STAND=test, plain http on localhost) or production
# (Caddy + HTTPS, docker-compose.prod.yml; S3 overlay when S3_BUCKET is set).
COMPOSE_FILES=()
setup_compose() {
  COMPOSE_FILES=(-f "$DEPLOY/docker-compose.yml")
  if [ "${ZVENA_STAND:-}" != "test" ]; then
    COMPOSE_FILES+=(-f "$DEPLOY/docker-compose.prod.yml")
    [ -n "${S3_BUCKET:-}" ] && COMPOSE_FILES+=(-f "$DEPLOY/docker-compose.s3.yml")
    case " ${DESIGN_EXTRA_FLAGS:-} " in
      *" disable-secure-session-cookies "*) die "DESIGN_EXTRA_FLAGS: disable-secure-session-cookies is not allowed in production" ;;
    esac
    [ "${ZVENA_DEV_LOGIN:-0}" = "1" ] && die "ZVENA_DEV_LOGIN=1 is not allowed in production"
    case "${APP_URL:-}" in https://*) ;; *) die "APP_URL must start with https://" ;; esac
    case "${DESIGN_URL:-}" in https://*) ;; *) die "DESIGN_URL must start with https://" ;; esac
  fi
  check_project
  return 0
}

# Two instances on one machine (production and a stand) must never share a compose
# project: up.sh or restore.sh with the wrong settings would replace the other one's
# containers or data. The project's containers remember the settings file they were
# started with; another file stops here.
check_project() {
  local project=${COMPOSE_PROJECT_NAME:-zvena} mine theirs f
  mine=$(readlink -f "$ENV_FILE")
  theirs=$(docker ps -a --filter "label=com.docker.compose.project=$project" \
    --format '{{.Label "com.docker.compose.project.environment_file"}}' 2>/dev/null | sort -u)
  for f in $theirs; do
    [ "$(readlink -f "$f")" = "$mine" ] && continue
    die "compose project \"$project\" belongs to $f, not $ENV_FILE: give this instance its own COMPOSE_PROJECT_NAME (and ports, BACKUP_DIR) in $ENV_FILE"
  done
  return 0
}

compose() {
  docker compose --env-file "$ENV_FILE" "${COMPOSE_FILES[@]}" --profile web "$@"
}

# Waits for /api/health of the web app to report every part ok.
wait_healthy() {
  local port=${WEB_PORT:-3100} _
  for _ in $(seq 1 60); do
    if curl -fsS -m 5 "http://127.0.0.1:$port/api/health" 2>/dev/null | grep -q '"ok":true'; then return 0; fi
    sleep 5
  done
  return 1
}

# tar that leaves out macOS metadata (xattrs, ._ files) when it runs on a Mac:
# GNU tar on the server warns about every such header.
tar_c() {
  if tar --version 2>/dev/null | grep -q bsdtar; then
    COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata "$@"
  else
    tar "$@"
  fi
}

require_root() { [ "$(id -u)" = 0 ] || die "run as root (sudo)"; }

# The prebuilt images of the release this checkout is (a tag vX.Y.Z on HEAD),
# published by .github/workflows/images.yml; nothing for any other commit, whose
# images are built from the checkout (build-images.sh). Prints three lines
# KEY=image for WEB_IMAGE, DESIGN_BACKEND_IMAGE and DESIGN_FRONTEND_IMAGE.
ZVENA_REGISTRY=${ZVENA_REGISTRY:-ghcr.io/zvena-app}
release_images() {
  local tag v
  tag=$(git -C "$ZVENA_DIR" describe --tags --exact-match --match 'v[0-9]*.[0-9]*.[0-9]*' HEAD 2>/dev/null) || return 1
  v=${tag#v}
  [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  echo "WEB_IMAGE=$ZVENA_REGISTRY/zvena-web:$v"
  echo "DESIGN_BACKEND_IMAGE=$ZVENA_REGISTRY/zvena-design-backend:$v"
  echo "DESIGN_FRONTEND_IMAGE=$ZVENA_REGISTRY/zvena-design-frontend:$v"
}
