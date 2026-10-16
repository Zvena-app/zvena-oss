# Shared bits of the zvena server scripts (sourced, not run).
#   ZVENA_ENV=/etc/zvena/zvena.env   the settings file (default)
# The settings file is parsed line by line (KEY=VALUE, optional double quotes)
# and never executed. Secrets are never printed.

set -euo pipefail
DEPLOY=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ZVENA_DIR=$(cd "$DEPLOY/.." && pwd)
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
  return 0
}

compose() {
  docker compose --env-file "$ENV_FILE" "${COMPOSE_FILES[@]}" --profile web "$@"
}

# Waits for /api/health of the web app to report every part ok.
wait_healthy() {
  local port=${WEB_PORT:-3100} i
  for i in $(seq 1 60); do
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
