#!/usr/bin/env bash
# Health watch for cron (every 5 minutes): the web app's /api/health (it also
# checks the database, files, Design and mail), the public HTTPS addresses,
# free disk and the age of the last backup. Mails ALERT_EMAIL when the state
# changes (problem / recovered) through the SMTP server from the settings,
# and logs one line per
# run without personal data. The new state is saved only once its alert went
# out, so a failed alert is tried again on the next run. Secrets reach curl
# through a config on a file descriptor, never on the command line (which any
# local user can read in /proc).
#   */5 * * * * root /opt/zvena/src/deploy/scripts/monitor.sh >> /var/log/zvena-monitor.log 2>&1
. "$(dirname "$0")/common.sh"
load_env
state_dir=/var/lib/zvena
mkdir -p "$state_dir"
problems=()

health=$(curl -sS -m 10 "http://127.0.0.1:${WEB_PORT:-3100}/api/health" 2>/dev/null || true)
echo "$health" | grep -q '"ok":true' || problems+=("health: ${health:-no response}")
if [ "${ZVENA_STAND:-}" != "test" ]; then
  for u in "$APP_URL/" "$DESIGN_URL/"; do
    code=$(curl -sS -o /dev/null -m 15 -w '%{http_code}' "$u" 2>/dev/null || echo 000)
    [ "$code" = 200 ] || problems+=("$u → $code")
  done
fi
used=$(df -P / | awk 'NR==2 {gsub("%", "", $5); print $5}')
[ "$used" -lt 90 ] || problems+=("disk is $used% full")
last=$(cat "${BACKUP_DIR:-/var/backups/zvena}/.last-ok" 2>/dev/null || echo 0)
age_h=$(( ($(date -u +%s) - last) / 3600 ))
[ "$age_h" -le 26 ] || problems+=("last backup $age_h h ago")

now="ok"
[ ${#problems[@]} -eq 0 ] || now="fail"
was=$(cat "$state_dir/monitor.state" 2>/dev/null || echo ok)
log "monitor $now ${problems[*]:-}"

# A value for a curl config line: quoted, with \ and " escaped.
curl_quote() {
  local v=${1//\\/\\\\}
  printf '"%s"' "${v//\"/\\\"}"
}

send_smtp() {
  local subject=$1 body=$2 from=${SMTP_FROM:-noreply@localhost} addr
  addr=$(echo "$from" | sed -E 's/.*<([^>]+)>.*/\1/')
  local proto=smtp
  [ "${SMTP_SECURE:-0}" = 1 ] && proto=smtps
  printf 'From: %s\r\nTo: %s\r\nSubject: =?UTF-8?B?%s?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n' \
    "$from" "$ALERT_EMAIL" "$(printf '%s' "$subject" | base64 -w0)" "$body" |
    curl -sS -f -m 30 --ssl-reqd --url "$proto://$SMTP_HOST:${SMTP_PORT:-587}" \
      -K <(printf 'user = %s\n' "$(curl_quote "${SMTP_USER:-}:${SMTP_PASS:-}")") \
      --mail-from "$addr" --mail-rcpt "$ALERT_EMAIL" --upload-file - >/dev/null
}

# 0: sent, or there is nowhere to send it; 1: it did not go out (retry next run).
send_mail() {
  [ -n "${ALERT_EMAIL:-}" ] || return 0
  if [ -n "${SMTP_HOST:-}" ]; then
    send_smtp "$1" "$2" || { log "monitor: the alert e-mail was not sent (SMTP), trying again next run"; return 1; }
  fi
  return 0
}
sent=0
if [ "$now" = "$was" ]; then
  sent=1
elif [ "$now" = fail ]; then
  send_mail "zvena: outage" "$(printf '%s\n' "${problems[@]}")" && sent=1
else
  send_mail "zvena: back to normal" "All checks passed." && sent=1
fi
# The state moves on only once its alert went out.
[ "$sent" = 1 ] && echo "$now" > "$state_dir/monitor.state"
[ "$now" = ok ]
