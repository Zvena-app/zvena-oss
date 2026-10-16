#!/usr/bin/env bash
# The MPL 2.0 source offer of zvena Design (the Penpot fork), for zvena's
# "Исходный код" page (/source):
#   zvena-design-<ver>-src.tar.gz       the fork's full source (Source Code Form)
#   zvena-design-<ver>-modified.tar.gz  only the files changed or added against Penpot 2.18.3
#   zvena-design-<ver>.patch            the same changes as one diff
#   manifest.json                       version, upstream, file lists, sizes, sha256
# Output: web/public/source/ (served by the web app) or $1.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(git -C "$HERE" rev-parse --show-toplevel)
PREFIX=${HERE#"$REPO"/}/src
BASE=$(cat "$HERE/UPSTREAM")
OUT=${1:-$REPO/web/public/source}
cd "$REPO"
[ -z "$(git status --porcelain -- "$PREFIX")" ] || { echo "commit $PREFIX first" >&2; exit 1; }
VER="2.18.3-zvena.$(git rev-parse --short HEAD)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"
rm -f "$OUT"/zvena-design-*
git diff --name-only --diff-filter=ACMR "$BASE" "HEAD:$PREFIX" > "$TMP/modified.txt"
git diff --name-only --diff-filter=D "$BASE" "HEAD:$PREFIX" > "$TMP/deleted.txt"
git diff "$BASE" "HEAD:$PREFIX" > "$OUT/zvena-design-$VER.patch"
# Full source without the heavy documentation media.
git archive --format=tar --prefix="zvena-design-$VER/" "HEAD:$PREFIX" | tar -x -C "$TMP"
( cd "$TMP" && tar --exclude="zvena-design-$VER/docs/img" -czf "$OUT/zvena-design-$VER-src.tar.gz" "zvena-design-$VER" )
( cd "$TMP/zvena-design-$VER" && tar -czf "$OUT/zvena-design-$VER-modified.tar.gz" -T "$TMP/modified.txt" )
python3 - "$OUT" "$VER" "$BASE" "$TMP/modified.txt" "$TMP/deleted.txt" <<'PY'
import hashlib, json, os, sys
out, ver, base, mod, dele = sys.argv[1:6]
files = {}
for name in sorted(os.listdir(out)):
    if name.startswith("zvena-design-"):
        p = os.path.join(out, name)
        files[name] = {"size": os.path.getsize(p), "sha256": hashlib.sha256(open(p, "rb").read()).hexdigest()}
json.dump({
  "version": ver,
  "upstream": {"name": "Penpot", "version": "2.18.3", "url": "https://github.com/penpot/penpot/tree/2.18.3", "license": "MPL-2.0"},
  "modified": [l.strip() for l in open(mod) if l.strip()],
  "deleted": [l.strip() for l in open(dele) if l.strip()],
  "files": files,
}, open(os.path.join(out, "manifest.json"), "w"), ensure_ascii=False, indent=1)
PY
du -sh "$OUT"/* | sed "s|$OUT/||"
