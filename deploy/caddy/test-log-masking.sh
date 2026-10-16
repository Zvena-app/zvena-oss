#!/usr/bin/env bash
# Proves that Caddy's logs keep no secret a URL carries (see the log-filter
# snippet in deploy/caddy/Caddyfile): the snippets and the global
# `log default` block are cut out of the real Caddyfile (so this test cannot
# drift from it) and run in the production Caddy image (its tag comes from
# deploy/docker-compose.prod.yml) in front of a stub upstream. Every kind of
# private link is requested with a dummy secret; then neither the access
# log nor Caddy's own log (a failed request is written there too) may hold
# any part of it, while each URL keeps its shape.
#
#   deploy/caddy/test-log-masking.sh        (needs docker; no network, no ports)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CADDYFILE="$HERE/Caddyfile"
IMAGE="${CADDY_IMAGE:-$(sed -n 's/^ *image: *\(caddy:[^ ]*\).*/\1/p' "$HERE/../docker-compose.prod.yml" | head -1)}"
[ -n "$IMAGE" ] || { echo "no caddy image in docker-compose.prod.yml" >&2; exit 2; }

SECRET="SECRETMARKERzvenaLOGTEST"
# Any piece of it is a leak too.
PIECES=("$SECRET" "DUMMY" "9f8e7d6c5b4a" "tok_DUM")

WORK="$(mktemp -d)"
NAME="zvena-log-mask-$$"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

# A top-level snippet: from "(name) {" to the "}" that closes it.
snippet() { awk -v head="($1) {" '$0 == head { on = 1 } on { print } on && $0 == "}" { exit }' "$CADDYFILE"; }
LOG_FILTER="$(snippet log-filter)"
LOG="$(snippet log)"
DEFAULT_LOG="$(awk '$0 == "\tlog default {" { on = 1 } on { print } on && $0 == "\t}" { exit }' "$CADDYFILE")"
[ -n "$LOG_FILTER" ] && [ -n "$LOG" ] && [ -n "$DEFAULT_LOG" ] || { echo "the Caddyfile lost (log-filter), (log) or 'log default'" >&2; exit 2; }
grep -q 'import log-filter' <<<"$LOG" || { echo "(log) does not import log-filter" >&2; exit 2; }
grep -q 'import log-filter' <<<"$DEFAULT_LOG" || { echo "'log default' does not import log-filter" >&2; exit 2; }

# The test stand's nginx (deploy/stand) keeps no access log at all: every
# server block says so.
STAND="$HERE/../stand/nginx-zvena-stand.conf"
if [ -f "$STAND" ]; then
  servers="$(grep -c '^server {' "$STAND")"
  off="$(grep -c '^  access_log off;' "$STAND")"
  [ "$servers" = "$off" ] || { echo "the stand's nginx: $off of $servers server blocks have access_log off" >&2; exit 1; }
fi

# The real Caddyfile adapts, and every logger in it (Caddy's own and each
# site's access log) has the filter.
docker run --rm --network none -e APP_DOMAIN=zvena.example -e DESIGN_DOMAIN=design.zvena.example -e ACME_EMAIL=ops@zvena.example \
  -v "$CADDYFILE:/etc/caddy/Caddyfile:ro" "$IMAGE" caddy adapt --config /etc/caddy/Caddyfile >"$WORK/adapted.json" 2>"$WORK/adapt.err" \
  || { cat "$WORK/adapt.err" >&2; echo "the Caddyfile does not adapt" >&2; exit 1; }
loggers="$(grep -o '"writer":' "$WORK/adapted.json" | wc -l)"
filtered="$(grep -o '"filter":"regexp"' "$WORK/adapted.json" | wc -l)"
[ "$loggers" -ge 2 ] && [ "$loggers" = "$filtered" ] || { echo "$filtered of $loggers loggers mask URLs" >&2; exit 1; }

cat >"$WORK/Caddyfile" <<EOF
$LOG_FILTER

{
	admin off
	auto_https off
$DEFAULT_LOG
}

$LOG

:8080 {
	import log
	# An upstream that is down: the failed request goes to Caddy's own log.
	handle /down/* {
		reverse_proxy 127.0.0.1:9
	}
	respond "ok" 200
}
EOF

docker run -d --name "$NAME" --network none -v "$WORK/Caddyfile:/etc/caddy/Caddyfile:ro" "$IMAGE" >/dev/null
for _ in $(seq 1 50); do
  docker exec "$NAME" wget -q -O /dev/null http://127.0.0.1:8080/ready 2>/dev/null && break
  sleep 0.2
done

S="$SECRET"
# The request, then what its "uri" must read in the log.
CASES=(
  "/api/calendar/feed/$S.ics" "/api/calendar/feed/***.ics"
  "/cal/acme/$S" "/cal/acme/***"
  "/cal/invite/$S" "/cal/invite/***"
  "/api/calendar/invite/$S" "/api/calendar/invite/***"
  "/api/calendar/public/acme/booking/$S/cancel" "/api/calendar/public/acme/booking/***/cancel"
  "/api/calendar/public/acme/slots?from=1&to=2&t=$S" "/api/calendar/public/acme/slots?from=1&to=2&t=***"
  "/join/$S" "/join/***"
  "/share/$S?_rsc=1x2y" "/share/***?_rsc=1x2y"
  "/f/$S" "/f/***"
  "/api/notes/form/$S" "/api/notes/form/***"
  "/n/$S" "/n/***"
  "/api/notes/file/$S.pdf?download=Report%20$S.pdf" "/api/notes/file/***.pdf?download=***"
  "/signin/email?token=$S" "/signin/email?token=***"
  "/signin?next=%2Fjoin%2F$S" "/signin?next=***"
  "/signin?next=/share/$S" "/signin?next=***"
  "/api/auth/callback/google?code=$S&state=$S" "/api/auth/callback/google?code=***&state=***"
  "/api/projects/attachments/a1b2?exp=1700000000&sig=$S" "/api/projects/attachments/a1b2?exp=1700000000&sig=***"
  "/api/mail/img?u=https%3A%2F%2Fmail.example%2Fp%3Fid%3D$S&s=$S" "/api/mail/img?u=***&s=***"
  "/api/main/methods/get-view-only-bundle?file-id=f1&share-id=$S" "/api/main/methods/get-view-only-bundle?file-id=f1&share-id=***"
  "/api/sso/start?email=$S%40example.com" "/api/sso/start?email=***"
  "/api/eco/search?ws=w1&q=$S" "/api/eco/search?ws=w1&q=***"
  "/api/notes/unfurl?url=https%3A%2F%2Fexample.com%2F$S" "/api/notes/unfurl?url=***"
  "/api/design/template?ws=w1&key=$S" "/api/design/template?ws=w1&key=***"
  "/oauth?Token=$S&device_id=$S" "/oauth?Token=***&device_id=***"
  "/cal/acme" "/cal/acme"
  "/docs?ws=w1" "/docs?ws=w1"
  "/down/join/$S?token=$S" "/down/join/***?token=***"
)

for ((i = 0; i < ${#CASES[@]}; i += 2)); do
  docker exec "$NAME" wget -q -O /dev/null \
    --header "Cookie: zv_session=$S" \
    --header "Authorization: Bearer $S" \
    --header "Referer: https://zvena.example/share/$S" \
    --header "X-Zvena-Key: $S" \
    --header "X-File-Name: $S.pdf" \
    --header "X-Name: $S" \
    --header "Cf-Connecting-Ip: 203.0.113.7" \
    "http://127.0.0.1:8080${CASES[i]}" 2>/dev/null || true
done
sleep 1

docker exec "$NAME" cat /data/logs/access.log >"$WORK/access.log"
docker logs "$NAME" >"$WORK/caddy.log" 2>&1

fail=0
bad() { echo "FAIL: $*" >&2; fail=1; }

for f in access.log caddy.log; do
  for p in "${PIECES[@]}"; do
    if grep -qF -- "$p" "$WORK/$f"; then
      bad "$f holds \"$p\":"; grep -F -- "$p" "$WORK/$f" | head -3 | cut -c1-400 >&2
    fi
  done
done

uris="$(grep -o '"uri":"[^"]*"' "$WORK/access.log" | sed 's/^"uri":"//; s/"$//' | sed 's/\\u0026/\&/g')"
for ((i = 0; i < ${#CASES[@]}; i += 2)); do
  want="${CASES[i + 1]}"
  grep -qxF -- "$want" <<<"$uris" || bad "no log line with uri $want (for ${CASES[i]})"
done
# The failed request is in Caddy's own log, masked the same way.
grep -q '"logger":"http.log.error' "$WORK/caddy.log" || bad "Caddy's own log has no failed request (the test did not exercise it)"
grep -qF '"uri":"/down/join/***?token=***"' "$WORK/caddy.log" || bad "Caddy's own log does not show the failed request's masked uri"

if [ "$fail" = 0 ]; then
  echo "ok: $(( ${#CASES[@]} / 2 )) URLs, no part of the secret in the access log or Caddy's own log ($IMAGE)"
else
  echo "--- access.log uris:" >&2; echo "$uris" >&2
  exit 1
fi
