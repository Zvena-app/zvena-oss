#!/usr/bin/env bash
# Loads an archive from save-images.sh and writes its image tags into the
# settings file. The images stream into docker load: no unpacked copy on disk.
#   sudo deploy/scripts/load-images.sh zvena-images-<tag>.tar.gz
. "$(dirname "$0")/common.sh"
require_root
load_env
f=${1:?image archive}
if [ -f "$f.sha256" ]; then
  (cd "$(dirname "$f")" && sha256sum -c "$(basename "$f").sha256") || die "the archive is damaged: its checksum does not match $f.sha256"
else
  log "no .sha256 file — integrity not checked"
fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
tar -C "$tmp" -xzf "$f" images.env
tar -xzOf "$f" images.tar | docker load | tee "$tmp/loaded.txt"
# docker load can name an image it failed to unpack and still exit 0: each
# image must give a container before its tag goes into the settings.
n=0
while read -r img; do
  c=$(docker create "$img" 2>/dev/null) || die "image $img did not unpack — the archive is damaged, build it again"
  docker rm "$c" >/dev/null
  n=$((n + 1))
done < <(sed -n 's/^Loaded image: //p' "$tmp/loaded.txt")
[ "$n" -gt 0 ] || die "no images found in the archive"
while IFS='=' read -r k v; do
  case "$k" in WEB_IMAGE|DESIGN_BACKEND_IMAGE|DESIGN_FRONTEND_IMAGE) set_env "$k" "$v" ;; esac
done < "$tmp/images.env"
log "images loaded, tags written to $ENV_FILE"
