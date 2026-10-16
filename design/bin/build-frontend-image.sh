#!/usr/bin/env bash
# The zvena Design frontend image from a built bundle (bin/build-frontend.sh).
#   bin/build-frontend-image.sh [<bundle dir>]   → prints the image tag
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
BUILD=${ZVENA_BUILD_DIR:-$HOME/.cache/zvena-design}
BUNDLE=$(readlink -f "${1:-$BUILD/dist/current}")
VERSION=$(cat "$BUNDLE/version.txt")
CTX=$BUILD/frontend-image
rm -rf "$CTX"; mkdir -p "$CTX"
cp -a "$BUNDLE" "$CTX/app"
cp "$HERE/deploy/frontend.Dockerfile" "$CTX/Dockerfile"
cp "$HERE/deploy/config.js" "$HERE/deploy/zvena-entrypoint.sh" "$HERE/deploy/nginx-gfonts-cache.conf" "$HERE/deploy/nginx-gfonts-locations.conf" "$HERE/deploy/nginx-app-locations.conf" "$CTX/"
docker build -q -t "zvena-design-frontend:$VERSION" "$CTX" >/dev/null
rm -rf "$CTX/app"
echo "zvena-design-frontend:$VERSION"
