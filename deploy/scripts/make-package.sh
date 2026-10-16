#!/usr/bin/env bash
# A package for moving zvena to a server: one folder and a .tar of it with
# the source (a Git bundle: this commit as main plus the Penpot snapshot tag),
# the Docker images for the server's platform and install.sh. The server then
# needs neither GitHub nor Docker Hub (see deploy/package/README.md).
#   ZVENA_ENV=<settings> deploy/scripts/make-package.sh <out dir> [linux/amd64|linux/arm64]
# From the settings only the image tags are read (WEB_IMAGE, DESIGN_*_IMAGE,
# written by build-images.sh); no secret goes into the package.
. "$(dirname "$0")/common.sh"
load_env
out=$(cd "${1:?folder for the package}" && pwd)
platform=${2:-linux/amd64}
cd "$ZVENA_DIR"
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "there are uncommitted changes: a package is built from a commit only"
ver=$(git rev-parse --short HEAD)
tag=$(git tag --points-at "$(cat design/UPSTREAM)" | head -1)
[ -n "$tag" ] || die "no tag on the Penpot snapshot $(cat design/UPSTREAM)"
name="zvena-server-$ver-${platform#linux/}"
dir="$out/$name"
[ ! -e "$dir" ] && [ ! -e "$dir.tar" ] || die "$dir or $dir.tar already exists"
mkdir "$dir"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

log "source: main = $ver and tag $tag"
git init -q --bare "$tmp/src.git"
git push -q --no-verify "$tmp/src.git" "HEAD:refs/heads/main" "refs/tags/$tag:refs/tags/$tag"
git -C "$tmp/src.git" symbolic-ref HEAD refs/heads/main
git -C "$tmp/src.git" bundle create -q "$dir/zvena-src.bundle" HEAD main "$tag"

log "images ($platform)"
SAVE_PLATFORM=$platform "$DEPLOY/scripts/save-images.sh" "$dir"
images=$(cd "$dir" && ls zvena-images-*.tar.gz)

cp "$DEPLOY/package/install.sh" "$DEPLOY/package/README.md" "$ZVENA_DIR/DEPLOY.md" "$dir/"
chmod 755 "$dir/install.sh"
cat > "$dir/package.env" <<PKG
COMMIT=$(git rev-parse HEAD)
PLATFORM=$platform
IMAGES=$images
WEB_IMAGE=$WEB_IMAGE
DESIGN_BACKEND_IMAGE=$DESIGN_BACKEND_IMAGE
DESIGN_FRONTEND_IMAGE=$DESIGN_FRONTEND_IMAGE
CREATED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
PKG
(cd "$dir" && sha256sum install.sh README.md DEPLOY.md package.env zvena-src.bundle "$images" "$images.sha256" > SHA256SUMS)

log "archive"
# The parts are compressed already; root as the owner.
if tar --version | grep -q bsdtar; then owner=(--uid 0 --gid 0 --uname root --gname root); else owner=(--owner=0 --group=0); fi
tar_c "${owner[@]}" -C "$out" -cf "$dir.tar" "$name"
(cd "$out" && sha256sum "$name.tar" > "$name.tar.sha256")
log "done: $dir/ and $dir.tar ($(du -h "$dir.tar" | cut -f1))"
