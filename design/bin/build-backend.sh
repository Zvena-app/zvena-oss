#!/usr/bin/env bash
# Build the zvena Design backend image from the committed fork (design/src):
# upstream penpotapp/backend:2.18.3 with the fork's changed backend/common
# sources laid over penpot.jar (it ships Clojure sources, not AOT classes).
# The changed files are those that differ from the Penpot 2.18.3 snapshot
# recorded in design/UPSTREAM (the commit of tag penpot-2.18.3).
#   bin/build-backend.sh            → prints the image tag
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(git -C "$HERE" rev-parse --show-toplevel)
PREFIX=${HERE#"$REPO"/}/src
UP=2.18.3
BASE=$(cat "$HERE/UPSTREAM")
BUILD=${ZVENA_BUILD_DIR:-$HOME/.cache/zvena-design}
cd "$REPO"
if [ -n "$(git status --porcelain -- "$PREFIX/backend" "$PREFIX/common")" ]; then
  echo "commit the backend/common changes in $PREFIX first" >&2; exit 1
fi
ver="$UP-zvena.$(git rev-parse --short HEAD)"
W=$BUILD/backend
rm -rf "$W"; mkdir -p "$W"
cid=$(docker create "penpotapp/backend:$UP")
docker cp "$cid:/opt/penpot/backend/penpot.jar" "$W/upstream.jar" >/dev/null
docker rm "$cid" >/dev/null
git diff --name-only --diff-filter=ACMR "$BASE" "HEAD:$PREFIX" -- backend/src backend/resources common/src > "$W/changed.txt"
git diff --name-only --diff-filter=D "$BASE" "HEAD:$PREFIX" -- backend/src backend/resources common/src > "$W/deleted.txt"
python3 "$HERE/tools/overlay-jar.py" "$W/upstream.jar" "$W/penpot.jar" "$REPO/$PREFIX" "$W/changed.txt" "$W/deleted.txt" | head -3
cp "$HERE/deploy/backend.Dockerfile" "$W/Dockerfile"
docker build -q -t "zvena-design-backend:$ver" "$W" >/dev/null
rm -f "$W/upstream.jar"
echo "zvena-design-backend:$ver"
