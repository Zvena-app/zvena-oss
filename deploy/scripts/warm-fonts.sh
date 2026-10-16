#!/usr/bin/env bash
# Fills Design's Google Fonts cache (the fonts-cache volume) ahead of time, so
# the fonts keep working even if Google becomes unreachable from the server.
# Fetches through Design itself (the same URLs the editor asks for): the CSS of
# each family, the web fonts it lists and the TTF files of the canvas renderer.
#   sudo deploy/scripts/warm-fonts.sh            # ~60 most used families
#   sudo deploy/scripts/warm-fonts.sh --cyrillic # families with Cyrillic (~290)
#   sudo deploy/scripts/warm-fonts.sh --all      # the whole catalog (~1900, several GB)
#   sudo deploy/scripts/warm-fonts.sh Inter Roboto "PT Sans"
. "$(dirname "$0")/common.sh"
require_root
load_env
command -v python3 >/dev/null || die "python3 is required"
port=${DESIGN_PORT:-3110}
name=$(docker ps --format '{{.Names}}' | grep -E "^${COMPOSE_PROJECT_NAME:-zvena}-design-frontend-1$" || true)
[ -n "$name" ] || die "the design-frontend container is not running"
catalog=$(mktemp)
trap 'rm -f "$catalog"' EXIT
docker exec "$name" sh -c 'cat /var/www/app/fonts/gfonts.*.json' > "$catalog"
log "warming the font cache through http://127.0.0.1:$port"
python3 - "$catalog" "http://127.0.0.1:$port" "$@" <<'PY'
import json, re, sys, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

catalog, base, args = sys.argv[1], sys.argv[2], sys.argv[3:]
items = json.load(open(catalog))["items"]
POPULAR = ["Inter", "Roboto", "Open Sans", "Montserrat", "Lato", "Poppins", "Noto Sans",
           "Raleway", "Nunito", "Nunito Sans", "Work Sans", "Rubik", "Source Sans 3", "PT Sans",
           "Ubuntu", "Oswald", "Playfair Display", "Merriweather", "Lora", "DM Sans", "Manrope",
           "Mulish", "Karla", "Barlow", "IBM Plex Sans", "IBM Plex Mono", "Fira Sans", "Fira Code",
           "Space Grotesk", "Plus Jakarta Sans", "Outfit", "Figtree", "Sora", "Urbanist", "Lexend",
           "Archivo", "Heebo", "Quicksand", "Josefin Sans", "Libre Baskerville", "Crimson Text",
           "EB Garamond", "Cormorant Garamond", "Bebas Neue", "Anton", "Archivo Black", "Inconsolata",
           "Roboto Mono", "JetBrains Mono", "Space Mono", "Source Code Pro", "Noto Serif",
           "Roboto Slab", "Roboto Condensed", "Libre Franklin", "Cabin", "Hind", "Titillium Web",
           "Dancing Script", "Pacifico", "Caveat", "Comfortaa", "Exo 2", "Golos Text", "Onest"]
if args == ["--all"]:
    fams = items
elif args == ["--cyrillic"]:
    fams = [f for f in items if "cyrillic" in f.get("subsets", [])]
elif args:
    want = {a.lower() for a in args}
    fams = [f for f in items if f["family"].lower() in want]
else:
    want = {p.lower() for p in POPULAR}
    fams = [f for f in items if f["family"].lower() in want]

GSTATIC = "https://fonts.gstatic.com/s/"
def get(path):
    try:
        with urllib.request.urlopen(base + path, timeout=60) as r:
            return r.status, r.read()
    except Exception as e:
        return getattr(e, "code", 0), b""

def warm(f):
    # The editor's CSS request: family=<name>:<variants in catalog order>&display=block
    q = "family=" + urllib.parse.quote(f["family"]) + ":" + ",".join(f["variants"]) + "&display=block"
    ok = fail = 0
    st, css = get("/internal/gfonts/css?" + q)
    files = re.findall(r"url\(" + re.escape(GSTATIC) + r"([^)]+)\)", css.decode("utf-8", "replace")) if st == 200 else []
    files += [u[len(GSTATIC):] for u in f.get("files", {}).values() if u.startswith(GSTATIC)]
    fail += st != 200
    for p in dict.fromkeys(files):
        s, _ = get("/internal/gfonts/font/" + p)
        if s == 200: ok += 1
        else: fail += 1
    return f["family"], ok, fail

total_ok = total_fail = 0
with ThreadPoolExecutor(4) as pool:
    for i, (fam, ok, fail) in enumerate(pool.map(warm, fams), 1):
        total_ok += ok; total_fail += fail
        if fail: print(f"  {fam}: {fail} failed", flush=True)
        if i % 25 == 0: print(f"  {i}/{len(fams)} families", flush=True)
print(f"done: {len(fams)} families, {total_ok} files, {total_fail} failed")
sys.exit(1 if total_fail and not total_ok else 0)
PY
