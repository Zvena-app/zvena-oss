#!/usr/bin/env bash
# Health watch for cron (every 5 minutes): the web app's /api/health (it also
# checks the database, files, Design and mail), the public HTTPS addresses,
# free disk and the age of the last backup. Mails ALERT_EMAIL when the state
# changes (problem / recovered) — through Resend's API when RESEND_API_KEY is
# set, else through the SMTP server from the settings — and logs one line per
# run without personal data.
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
echo "$now" > "$state_dir/monitor.state"
log "monitor $now ${problems[*]:-}"

# Resend's API: the JSON body is built by python3 (subject and text come in
# through the environment, so no quoting can break it).
send_resend() {
  local subject=$1 body=$2
  MAIL_SUBJECT=$subject MAIL_BODY=$body MAIL_TO=$ALERT_EMAIL MAIL_SENDER=${MAIL_FROM:-zvena <noreply@localhost>} python3 -c '
import json, os
print(json.dumps({"from": os.environ["MAIL_SENDER"], "to": [os.environ["MAIL_TO"]], "subject": os.environ["MAIL_SUBJECT"], "text": os.environ["MAIL_BODY"]}))' |
    curl -sS -f -m 30 https://api.resend.com/emails \
      -H "Authorization: Bearer $RESEND_API_KEY" -H 'Content-Type: application/json' --data-binary @- >/dev/null
}

send_smtp() {
  local subject=$1 body=$2 from=${SMTP_FROM:-noreply@localhost} addr
  addr=$(echo "$from" | sed -E 's/.*<([^>]+)>.*/\1/')
  local proto=smtp
  [ "${SMTP_SECURE:-0}" = 1 ] && proto=smtps
  printf 'From: %s\r\nTo: %s\r\nSubject: =?UTF-8?B?%s?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n' \
    "$from" "$ALERT_EMAIL" "$(printf '%s' "$subject" | base64 -w0)" "$body" |
    curl -sS -m 30 --ssl-reqd --url "$proto://$SMTP_HOST:${SMTP_PORT:-587}" \
      --user "$SMTP_USER:$SMTP_PASS" --mail-from "$addr" --mail-rcpt "$ALERT_EMAIL" --upload-file - >/dev/null
}

send_mail() {
  [ -n "${ALERT_EMAIL:-}" ] || return 0
  if [ -n "${RESEND_API_KEY:-}" ]; then
    send_resend "$1" "$2" || log "monitor: the alert e-mail was not sent (Resend)"
  elif [ -n "${SMTP_HOST:-}" ]; then
    send_smtp "$1" "$2" || log "monitor: the alert e-mail was not sent (SMTP)"
  fi
}
if [ "$now" != "$was" ]; then
  if [ "$now" = fail ]; then
    send_mail "zvena: outage" "$(printf '%s\n' "${problems[@]}")"
  else
    send_mail "zvena: back to normal" "All checks passed."
  fi
fi
[ "$now" = ok ]
