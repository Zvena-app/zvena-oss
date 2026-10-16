#!/usr/bin/env bash
# Creates the settings file from .env.example with fresh secrets
# (and the backup passphrase file). Never overwrites an existing file and
# never prints a secret.
#   sudo deploy/scripts/init-env.sh            → /etc/zvena/zvena.env
#   sudo ZVENA_ENV=/etc/zvena/staging.env deploy/scripts/init-env.sh   a second instance (stand)
. "$(dirname "$0")/common.sh"
require_root
command -v openssl >/dev/null || die "openssl is required"
[ -e "$ENV_FILE" ] && die "$ENV_FILE already exists — edit it by hand"
# A second instance on a machine that already runs zvena (a stand next to production:
# README, "Test stand") gets its own compose project, passphrase file and backup
# folder, named after its settings file — never the first instance's.
second=0
name=$(basename "$ENV_FILE" .env)
name=${name#zvena-}
if [ "$(readlink -m "$ENV_FILE")" != /etc/zvena/zvena.env ] && { [ -e /etc/zvena/zvena.env ] || [ -n "$(docker ps -aq --filter label=com.docker.compose.project=zvena 2>/dev/null)" ]; }; then
  [ "$name" != zvena ] || die "another zvena runs here: name this instance's settings file after it, e.g. /etc/zvena/staging.env"
  second=1
fi
install -d -m 700 "$(dirname "$ENV_FILE")"
umask 077
cp "$DEPLOY/.env.example" "$ENV_FILE"
chmod 600 "$ENV_FILE"
for k in PG_PASSWORD AUTH_SECRET DESIGN_SECRET_KEY DESIGN_MGMT_KEY DESIGN_OIDC_CLIENT_SECRET ZVENA_INTERNAL_KEY; do
  set_env "$k" "$(openssl rand -hex 32)"
done
# A second instance (see above): its own compose project, passphrase file and backups.
if [ "$second" = 1 ]; then
  set_env COMPOSE_PROJECT_NAME "zvena-$name"
  set_env BACKUP_PASSPHRASE_FILE "${ENV_FILE%.env}.backup.pass"
  set_env BACKUP_DIR "/var/backups/zvena-$name"
fi
rm -f "$ENV_FILE.prev"
load_env
log "created $ENV_FILE (secrets generated)"
if [ ! -e "$BACKUP_PASSPHRASE_FILE" ]; then
  openssl rand -base64 48 | tr -d '\n' > "$BACKUP_PASSPHRASE_FILE"
  chmod 600 "$BACKUP_PASSPHRASE_FILE"
  log "created $BACKUP_PASSPHRASE_FILE"
else
  log "kept the existing $BACKUP_PASSPHRASE_FILE"
fi
echo "Next: open $ENV_FILE and fill in the domains, ACME_EMAIL, the operator details (ZVENA_COMPANY_NAME, ZVENA_CONTACT_EMAIL),"
echo "  your legal pages (ZVENA_TERMS_URL, ZVENA_PRIVACY_URL) and your SMTP server (SMTP_*) for sign-in links and invitations."
echo "Keep a copy of $BACKUP_PASSPHRASE_FILE away from the server (a password manager): backups cannot be restored without it."
if [ "$second" = 1 ]; then
  echo "Another zvena runs on this machine: this one is the compose project $COMPOSE_PROJECT_NAME, backs up to $BACKUP_DIR,"
  echo "  and needs its own ports in $ENV_FILE (WEB_PORT, DESIGN_PORT, DESIGN_BACKEND_PORT; defaults 3100, 3110, 3111)."
fi
