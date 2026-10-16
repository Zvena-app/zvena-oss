#!/usr/bin/env bash
# zvena: tell the Design frontend where zvena is and its support address
# (app.zvena reads penpotZvenaURI, penpotZvenaSupportEmail), then run
# Penpot's own entrypoint.
set -e
if [ -n "$PENPOT_ZVENA_URI" ]; then
  echo "var penpotZvenaURI = \"$PENPOT_ZVENA_URI\";" >> /var/www/app/js/config.js
fi
# The instance's support address (help menu, feedback page); none → hidden.
support=$(printf '%s' "${PENPOT_ZVENA_SUPPORT_EMAIL:-}" | tr -d '"\\<>\r\n ')
if [ -n "$support" ]; then
  echo "var penpotZvenaSupportEmail = \"$support\";" >> /var/www/app/js/config.js
fi
# The Google Fonts cache lives on the fonts-cache volume; a volume this user
# cannot write (e.g. created root-owned by an older image) falls back to /tmp.
if ! { mkdir -p /opt/data/gfonts && [ -w /opt/data/gfonts ]; } 2>/dev/null; then
  sed -i 's|/opt/data/gfonts|/tmp/gfonts|' /etc/nginx/overrides/http.d/zvena-gfonts-cache.conf
  echo "zvena: /opt/data/gfonts is not writable, fonts are cached in /tmp" >&2
fi
exec /bin/bash /entrypoint.sh "$@"
