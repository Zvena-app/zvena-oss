#!/usr/bin/env bash
# Packs the images named in the settings file into one archive, for a server
# that does not build them itself (see DEPLOY.md, "Images: build on another machine").
#   deploy/scripts/save-images.sh [<out dir>]   → zvena-images-<web tag>.tar.gz + .sha256
# SAVE_PLATFORM=linux/amd64 saves that platform only and checks that every
# image really is built for it (a build machine can hold several).
. "$(dirname "$0")/common.sh"
load_env
out=${1:-.}
[ -n "${WEB_IMAGE:-}" ] && [ -n "${DESIGN_BACKEND_IMAGE:-}" ] && [ -n "${DESIGN_FRONTEND_IMAGE:-}" ] || die "no image tags in the settings (build-images.sh)"
name="zvena-images-${WEB_IMAGE#*:}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
printf 'WEB_IMAGE=%s\nDESIGN_BACKEND_IMAGE=%s\nDESIGN_FRONTEND_IMAGE=%s\n' "$WEB_IMAGE" "$DESIGN_BACKEND_IMAGE" "$DESIGN_FRONTEND_IMAGE" > "$tmp/images.env"
plat=()
[ -n "${SAVE_PLATFORM:-}" ] && plat=(--platform "$SAVE_PLATFORM")
docker save ${plat[@]+"${plat[@]}"} "$WEB_IMAGE" "$DESIGN_BACKEND_IMAGE" "$DESIGN_FRONTEND_IMAGE" penpotapp/exporter:2.18.3 postgres:15 valkey/valkey:8.1 caddy:2.10.2-alpine > "$tmp/images.tar"
if [ -n "${SAVE_PLATFORM:-}" ]; then
  python3 - "$tmp/images.tar" "${SAVE_PLATFORM#*/}" <<'PY' || die "the archive has images that are not for $SAVE_PLATFORM"
import json, sys, tarfile
tar, want = tarfile.open(sys.argv[1]), sys.argv[2]
bad = []
for image in json.load(tar.extractfile("manifest.json")):
    arch = json.load(tar.extractfile(image["Config"])).get("architecture")
    if arch != want:
        bad.append(f"{' '.join(image.get('RepoTags') or ['?'])}: {arch}")
print("\n".join(bad), file=sys.stderr)
sys.exit(1 if bad else 0)
PY
fi
tar_c -C "$tmp" -czf "$out/$name.tar.gz" images.env images.tar
(cd "$out" && sha256sum "$name.tar.gz" > "$name.tar.gz.sha256")
log "$out/$name.tar.gz ($(du -h "$out/$name.tar.gz" | cut -f1))"
