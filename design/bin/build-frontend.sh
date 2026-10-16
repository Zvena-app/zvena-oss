#!/usr/bin/env bash
# Build the zvena Design frontend bundle (the Penpot fork) inside penpotapp/devenv.
#
#   bin/build-frontend.sh            # from the working tree (dev)
#   bin/build-frontend.sh --release  # require a committed tree
#
# Output: $BUILD/dist/<version>/ (+ dist/current symlink).
#
# Disk-light on a shared machine: when LOWER (a previous Penpot build tree
# with node_modules, the shadow-cljs cache and the compiled render-wasm,
# set with ZVENA_BUILD_LOWER) exists, the work tree is an overlay on
# top of it — LOWER is only read, every write lands in $BUILD/overlay/upper.
# Without LOWER the work tree is a plain directory (a full install, ~3 GB).
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(git -C "$HERE" rev-parse --show-toplevel)
SRC=$HERE/src
BUILD=${ZVENA_BUILD_DIR:-$HOME/.cache/zvena-design}
LOWER=${ZVENA_BUILD_LOWER:-}
IMAGE=${DEVENV_IMAGE:-penpotapp/devenv:latest}
CACHE=$BUILD/cache
DIST=$BUILD/dist

RELEASE=0
[ "${1:-}" = "--release" ] && RELEASE=1

cd "$REPO"
COMMIT=$(git rev-parse --short HEAD)
DIRTY=""
if [ -n "$(git status --porcelain -- "${SRC#"$REPO"/}")" ]; then
  [ $RELEASE = 1 ] && { echo "release build needs a committed tree" >&2; exit 1; }
  DIRTY="-dirty"
fi
VERSION="2.18.3-zvena.$COMMIT$DIRTY"
WASM_HASH=$(git rev-parse "HEAD:${SRC#"$REPO"/}/render-wasm")
echo "== building $VERSION (render-wasm tree $WASM_HASH)"

mkdir -p "$CACHE"/{m2,gitlibs,cargo-registry,cargo-git} "$DIST"
WORK=$BUILD/overlay/merged
if [ -d "$LOWER/frontend/node_modules" ]; then
  mkdir -p "$BUILD/overlay"/{upper,ovl,merged}
  if ! mountpoint -q "$WORK"; then
    mount -t overlay overlay -o "lowerdir=$LOWER,upperdir=$BUILD/overlay/upper,workdir=$BUILD/overlay/ovl" "$WORK"
  fi
  # Dependency caches: seeded once from the lower tree's machine caches if present.
  for c in m2 gitlibs cargo-registry cargo-git; do
    if [ -z "$(ls -A "$CACHE/$c")" ] && [ -d "$(dirname "$LOWER")/../cache/$c" ]; then cp -a "$(dirname "$LOWER")/../cache/$c/." "$CACHE/$c/"; fi
  done
  trap 'umount "$WORK" 2>/dev/null || true' EXIT
else
  WORK=$BUILD/work
  mkdir -p "$WORK"
fi

rsync -a --delete \
  --exclude '.git' --exclude 'node_modules' --exclude '.pnpm-store' \
  --exclude '.shadow-cljs' --exclude '.cpcache' \
  --exclude '/frontend/target' --exclude '/render-wasm/target' --exclude '/exporter/target' \
  --exclude 'frontend/resources/public' --exclude 'plugins/dist' \
  --exclude 'frontend/packages/ui/dist' \
  --exclude 'frontend/src/app/render_wasm/api/shared.js' \
  --exclude '/mcp' \
  "$SRC"/ "$WORK"/

nice -n 15 docker run --rm --name zvena-design-build \
  --memory "${BUILD_MEMORY:-7g}" --cpus "${BUILD_CPUS:-2}" \
  -e VERSION="$VERSION" -e WASM_HASH="$WASM_HASH" \
  -e _JAVA_OPTIONS="-Xmx4g -Xss8m" \
  -e NODE_OPTIONS="--max-old-space-size=3072" \
  -e CI=true \
  -v "$WORK":/work \
  -v "$CACHE/m2":/root/.m2 \
  -v "$CACHE/gitlibs":/root/.gitlibs \
  -v "$CACHE/cargo-registry":/opt/cargo/registry \
  -v "$CACHE/cargo-git":/opt/cargo/git \
  --entrypoint bash "$IMAGE" -c '
set -euo pipefail
EMSDK_QUIET=1 . /opt/emsdk/emsdk_env.sh
export CARGO_HOME=/opt/cargo
export NODE_ENV=production
export BUILD_DATE=$(date -R) BUILD_TS=$(date +%s)
export VERSION_TAG="${VERSION}-${BUILD_TS}"
cd /work/frontend

pnpm install --frozen-lockfile
(cd ../plugins/libs/plugins-runtime && pnpm install --frozen-lockfile && pnpm run build)
rm -rf resources/public target/dist
mkdir -p resources/public/css resources/public/js target/dist

RT=../render-wasm/target
if [ -f $RT/wasm32-unknown-emscripten/release/render_wasm.wasm ] && [ "$(cat $RT/.zvena-wasm-tree 2>/dev/null)" = "$WASM_HASH" ]; then
  echo "== render-wasm: reuse compiled target"
  (cd ../render-wasm && . ./_build_env && setup >/dev/null && copy_artifacts ../frontend/resources/public/js && copy_shared_artifact)
else
  echo "== building render-wasm"
  (cd ../render-wasm && ./build)
  echo "$WASM_HASH" > $RT/.zvena-wasm-tree
fi
test -f resources/public/js/worker/render.js

echo "== plugins"
# build:plugins runs every plugin at once (--parallel) and runs out of
# memory on a fresh tree: the same plugins, two at a time.
(cd ../plugins && pnpm -r install --frozen-lockfile && pnpm --workspace-concurrency=2 --filter "./apps/*-plugin" --filter "./apps/*-test-suite" --filter "!poc-state-plugin" run build)
echo "== ui package"
(cd packages/ui && pnpm run build)
echo "== common java classes"
# app.common.UUIDv8 is loaded by the cljs macros; a fresh tree has no
# common/target/classes yet (a reused build tree had them).
(cd ../common && clojure -T:build compile)
echo "== app"
pnpm run build:app:main
pnpm run build:app:libs
pnpm run build:app:assets
sed -i "s/\.\/render.js/.\/render.js?version=$VERSION_TAG/g" resources/public/js/worker/main*.js
rsync -a resources/public/ target/dist/
rsync -a ../plugins/dist/apps/ target/dist/plugins/
echo "$VERSION" > target/dist/version.txt
'

OUT="$DIST/$VERSION"
rm -rf "$OUT"
cp -a "$WORK/frontend/target/dist" "$OUT"
ln -sfn "$OUT" "$DIST/current"
echo "== bundle at $OUT ($(du -sh "$OUT" | cut -f1))"
