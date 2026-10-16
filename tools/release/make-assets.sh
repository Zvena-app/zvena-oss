#!/usr/bin/env bash
# The files attached to a GitHub release, made from a tag and nothing else:
#   zvena-<ver>-src.tar.gz   the tree of <tag> (git archive, gzip -n: the same tag
#                            gives the same bytes on any machine with the same git)
#   SHA256SUMS               sha256 of every file here (`sha256sum -c SHA256SUMS`)
# and with --web-image, also
#   zvena-web-<ver>-<arch>.tar.gz   the web image built from that tarball
#                            (deploy/web.Dockerfile; `docker load -i`). Docker
#                            images are not bit-for-bit reproducible: its checksum
#                            identifies the file, rebuilding gives another one.
#
#   tools/release/make-assets.sh v1.0.0 /tmp/release [--web-image]
#
# Run it in a clone that has the tag; uncommitted changes are never included.
# The tarball is not a substitute for a Git clone when you build Design: Design's
# build and the "Source code" page need the history (tag penpot-2.18.3), see DEPLOY.md.
set -euo pipefail
tag=${1:?usage: make-assets.sh <tag> <out-dir> [--web-image]}
out=${2:?usage: make-assets.sh <tag> <out-dir> [--web-image]}
web=0
[ "${3:-}" = "--web-image" ] && web=1
cd "$(git rev-parse --show-toplevel)"
git rev-parse -q --verify "refs/tags/$tag" >/dev/null || { echo "error: no tag $tag" >&2; exit 1; }
ver=${tag#v}
mkdir -p "$out"
out=$(cd "$out" && pwd)
src="zvena-$ver-src.tar.gz"

# tar.umask fixes the file modes; the mtime of every entry is the tagged commit's time.
git -c tar.umask=0022 archive --format=tar --prefix="zvena-$ver/" "$tag^{commit}" | gzip -n -9 > "$out/$src.part"
mv "$out/$src.part" "$out/$src"
echo "$src: $(du -h "$out/$src" | cut -f1)"

if [ "$web" = 1 ]; then
  command -v docker >/dev/null || { echo "error: --web-image needs docker" >&2; exit 1; }
  arch=$(docker version --format '{{.Server.Arch}}')
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  tar -xzf "$out/$src" -C "$tmp"
  image="zvena-web:$ver"
  docker build -q -f "$tmp/zvena-$ver/deploy/web.Dockerfile" -t "$image" "$tmp/zvena-$ver/web" >/dev/null
  docker save "$image" | gzip -n > "$out/zvena-web-$ver-$arch.tar.gz"
  echo "zvena-web-$ver-$arch.tar.gz: $(du -h "$out/zvena-web-$ver-$arch.tar.gz" | cut -f1) (image $image)"
fi

(cd "$out" && find . -maxdepth 1 -type f -name 'zvena-*.tar.gz' -printf '%f\n' | LC_ALL=C sort | xargs sha256sum > SHA256SUMS)
cat "$out/SHA256SUMS"
