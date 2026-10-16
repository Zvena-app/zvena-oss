#!/usr/bin/env bash
# Installs zvena on a server from this package (deploy/scripts/make-package.sh):
# the source (a Git bundle) goes to /opt/zvena/src, the settings with fresh
# secrets to /etc/zvena/zvena.env, the Docker images are loaded. With --start
# it also starts the service, makes the first backup and turns on the nightly
# backups and the health check (/etc/cron.d/zvena). Neither GitHub nor Docker
# Hub is needed; Docker itself comes from apt when it is missing.
#   sudo ./install.sh                          asks for the domain
#   sudo ./install.sh --domain example.com [--design-domain design.example.com]
#                     [--email admin@example.com] [--start]
# Safe to run again: the source, the settings and the loaded images are kept.
# Other places: ZVENA_HOME (default /opt/zvena), ZVENA_ENV (/etc/zvena/zvena.env).
set -euo pipefail
PKG=$(cd "$(dirname "$0")" && pwd)
ZVENA_HOME=${ZVENA_HOME:-/opt/zvena}
SRC=$ZVENA_HOME/src
export ZVENA_ENV=${ZVENA_ENV:-/etc/zvena/zvena.env}

die() { echo "error: $*" >&2; exit 1; }
say() { echo "== $*"; }
pkg() { sed -n "s/^$1=//p" "$PKG/package.env"; }

domain='' design='' email='' start=0
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) domain=${2:?}; shift 2 ;;
    --design-domain) design=${2:?}; shift 2 ;;
    --email) email=${2:?}; shift 2 ;;
    --start) start=1; shift ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done
[ "$(id -u)" = 0 ] || die "run as root: sudo $0"

want=$(pkg PLATFORM); want=${want#linux/}
case "$(uname -m)" in
  x86_64|amd64) have=amd64 ;;
  aarch64|arm64) have=arm64 ;;
  *) have=$(uname -m) ;;
esac
[ "$have" = "$want" ] || die "the package is built for $want, but this server is $have: you need a linux/$have package (make-package.sh)"

say "checking the package's integrity"
(cd "$PKG" && sha256sum --quiet -c SHA256SUMS) || die "package files are damaged — copy the archive again"

# --- Docker and tools -----------------------------------------------------
need=()
for c in git:git openssl:openssl curl:curl gpg:gnupg rsync:rsync python3:python3; do
  command -v "${c%%:*}" >/dev/null || need+=("${c#*:}")
done
command -v docker >/dev/null || need+=(docker.io)
docker compose version >/dev/null 2>&1 || need+=(docker-compose-v2)
if [ ${#need[@]} -gt 0 ]; then
  command -v apt-get >/dev/null || die "install these yourself: ${need[*]} (Docker Engine and docker compose v2)"
  say "installing packages: ${need[*]}"
  DEBIAN_FRONTEND=noninteractive apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q "${need[@]}"
fi
if command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then
  systemctl enable --now docker >/dev/null 2>&1 || true
fi
docker info >/dev/null 2>&1 || die "Docker is not running (systemctl status docker)"
docker compose version >/dev/null 2>&1 || die "docker compose v2 is missing"

mem_gb=$(awk '/^MemTotal/ {printf "%d", $2 / 1024 / 1024 + 0.5}' /proc/meminfo)
[ "$mem_gb" -ge 8 ] || echo "warning: $mem_gb GB of memory, zvena is sized for 8 GB"
free_gb=$(df -Pk "$(docker info -f '{{.DockerRootDir}}')" | awk 'NR==2 {printf "%d", $4 / 1024 / 1024}')
[ "$free_gb" -ge 20 ] || echo "warning: $free_gb GB free for Docker, 20 GB or more is needed (images ~8 GB, plus data)"

# --- Source -----------------------------------------------------------------
# A newer package over a running zvena is an update: backup first, then the
# source moves forward (fast-forward only) and the new images are loaded.
if [ -d "$SRC/.git" ]; then
  if [ "$(git -C "$SRC" rev-parse HEAD)" = "$(pkg COMMIT)" ]; then
    say "source already in place: $SRC ($(git -C "$SRC" rev-parse --short HEAD))"
  else
    port=$(sed -n 's/^WEB_PORT=//p' "$ZVENA_ENV" 2>/dev/null)
    if curl -fsS -m 5 "http://127.0.0.1:${port:-3100}/api/health" >/dev/null 2>&1; then
      say "backup before the update"
      "$SRC/deploy/scripts/backup.sh"
    fi
    say "updating the source $(git -C "$SRC" rev-parse --short HEAD) → $(pkg COMMIT | cut -c1-7)"
    git -C "$SRC" fetch -q "$PKG/zvena-src.bundle" 'refs/tags/*:refs/tags/*' +refs/heads/main:refs/remotes/package/main ||
      die "could not take the source from $PKG/zvena-src.bundle"
    git -C "$SRC" merge -q --ff-only refs/remotes/package/main ||
      die "$SRC has its own commits or changes — update it by hand (git -C $SRC status)"
  fi
elif [ -e "$SRC" ]; then
  die "$SRC exists but is not a Git repository"
else
  say "source → $SRC"
  install -d -m 755 "$ZVENA_HOME"
  git clone -q "$PKG/zvena-src.bundle" "$SRC"
  git -C "$SRC" fetch -q "$PKG/zvena-src.bundle" 'refs/tags/*:refs/tags/*'
  git -C "$SRC" remote set-url origin https://github.com/Zvena-app/zvena-oss.git
fi
[ "$(git -C "$SRC" cat-file -t "$(cat "$SRC/design/UPSTREAM")" 2>/dev/null)" = commit ] ||
  die "$SRC lacks the Penpot snapshot named in design/UPSTREAM (tag penpot-2.18.3)"

# --- Settings ---------------------------------------------------------------
# common.sh: load_env / set_env over $ZVENA_ENV, and its own die/log.
. "$SRC/deploy/scripts/common.sh"
fresh=0
if [ ! -e "$ENV_FILE" ]; then
  "$SRC/deploy/scripts/init-env.sh" >/dev/null
  fresh=1
fi
# The settings before this run: kept as $ENV_FILE.prev when they change, so
# `cp zvena.env.prev zvena.env && up.sh` rolls back (as after update.sh).
cp -p "$ENV_FILE" "$ENV_FILE.before-install"
load_env
if [ -z "$domain" ] && [ "$fresh" = 1 ] && [ -t 0 ]; then
  read -rp "Site domain [$APP_DOMAIN]: " domain
fi
if [ -n "$domain" ]; then
  domain=${domain#https://}; domain=${domain%%/*}
  design=${design:-design.$domain}
  email=${email:-admin@$domain}
  for v in "$domain" "$design"; do
    [[ "$v" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || die "does not look like a domain: $v"
  done
  [[ "$email" =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]] || die "does not look like an e-mail address: $email"
  set_env APP_DOMAIN "$domain"
  set_env APP_URL "https://$domain"
  set_env DESIGN_DOMAIN "$design"
  set_env DESIGN_URL "https://$design"
  set_env ACME_EMAIL "$email"
fi
log "settings: $ENV_FILE (site $APP_URL, Design $DESIGN_URL)"

# --- Images -----------------------------------------------------------------
loaded=1
for k in WEB_IMAGE DESIGN_BACKEND_IMAGE DESIGN_FRONTEND_IMAGE; do
  [ "${!k:-}" = "$(pkg "$k")" ] && docker image inspect "${!k}" >/dev/null 2>&1 || loaded=0
done
if [ "$loaded" = 1 ]; then
  log "this package's images are already loaded"
else
  say "loading the images (a few minutes)"
  "$SRC/deploy/scripts/load-images.sh" "$PKG/$(pkg IMAGES)"
  load_env
fi
if [ "$fresh" = 1 ] || cmp -s "$ENV_FILE" "$ENV_FILE.before-install"; then
  rm -f "$ENV_FILE.before-install" "$ENV_FILE.prev"
else
  mv "$ENV_FILE.before-install" "$ENV_FILE.prev"
  log "previous settings: $ENV_FILE.prev"
fi

# --- Start ------------------------------------------------------------------
if [ "$start" = 0 ] && [ -t 0 ]; then
  read -rp "Start zvena now (DNS and ports 80/443 are ready)? [y/N] " a
  case "$a" in [Yy]*) start=1 ;; esac
fi
if [ "$start" = 1 ]; then
  for d in "$APP_DOMAIN" "$DESIGN_DOMAIN"; do
    # getent fails for a name without DNS records: report it, do not stop here.
    ip=$(getent ahosts "$d" 2>/dev/null | awk 'NR==1 {print $1}' || true)
    log "DNS: $d → ${ip:-not found} (this server's addresses: $(hostname -I 2>/dev/null | xargs))"
  done
  "$SRC/deploy/scripts/up.sh"
  say "first backup"
  "$SRC/deploy/scripts/backup.sh" || echo "warning: the backup failed, see the output above"
  if [ -d /etc/cron.d ]; then
    cat > /etc/cron.d/zvena <<CRON
# zvena (install.sh): encrypted backup every night, health check every 5 minutes.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ZVENA_ENV=$ENV_FILE
30 3 * * * root $SRC/deploy/scripts/backup.sh >> /var/log/zvena-backup.log 2>&1
*/5 * * * * root $SRC/deploy/scripts/monitor.sh >> /var/log/zvena-monitor.log 2>&1
CRON
    chmod 644 /etc/cron.d/zvena
    log "nightly backups and the health check: /etc/cron.d/zvena"
  else
    echo "warning: no /etc/cron.d — add backup.sh and monitor.sh to cron yourself (DEPLOY.md, \"Backups\" and \"Monitoring\")"
  fi
fi

cat <<DONE

Done. zvena $(git -C "$SRC" rev-parse --short HEAD) in $SRC.
  Settings: $ENV_FILE
    fill in the company details (ZVENA_COMPANY_*, ZVENA_GOVERNING_LAW), e-mail through Resend
    (RESEND_API_KEY, MAIL_FROM), the sign-in keys (GOOGLE_CLIENT_*, GITHUB_CLIENT_*),
    ZVENA_ADMIN_EMAIL and ALERT_EMAIL — without sign-in keys nobody can sign in.
  Backup passphrase: $BACKUP_PASSPHRASE_FILE — keep a copy away from the server.
DONE
if [ "$start" = 1 ]; then
  cat <<DONE
  Running: $APP_URL (status: $APP_URL/status).
  After editing the settings: sudo $SRC/deploy/scripts/up.sh
DONE
else
  cat <<DONE
  Next:
    1. DNS: A records $APP_DOMAIN, $DESIGN_DOMAIN and www.$APP_DOMAIN → this server's IP.
    2. Open ports 80 and 443 (ufw allow 80/tcp; ufw allow 443/tcp; ufw allow 443/udp).
    3. Start: sudo $PKG/install.sh --start
DONE
fi
echo "  Details: $SRC/DEPLOY.md"
