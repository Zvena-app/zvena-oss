#!/usr/bin/env python3
"""Rebuild penpot.jar: upstream entries, with the fork's changed files laid over.

usage: overlay-jar.py UPSTREAM.jar OUT.jar SRC_ROOT CHANGED.txt DELETED.txt
CHANGED/DELETED list repo paths (backend/src/..., backend/resources/..., common/src/...);
each maps to the jar path without that prefix.
"""
import sys, zipfile

PREFIXES = ("backend/src/", "backend/resources/", "common/src/")


def jar_path(p):
    for pre in PREFIXES:
        if p.startswith(pre):
            return p[len(pre):]
    raise SystemExit(f"unexpected path {p}")


up, out, src, changed, deleted = sys.argv[1:6]
changed = [l.strip() for l in open(changed) if l.strip()]
deleted = {jar_path(l.strip()) for l in open(deleted) if l.strip()}
replace = {jar_path(p): p for p in changed}

zin = zipfile.ZipFile(up)
names = set(zin.namelist())
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
    for info in zin.infolist():
        if info.filename in replace or info.filename in deleted:
            continue
        zout.writestr(info, zin.read(info.filename))
    for jp, rp in sorted(replace.items()):
        # parent directory entries keep the jar browsable; the class loader does not need them
        zout.write(f"{src}/{rp}", jp)
added = [jp for jp in replace if jp not in names]
print(f"replaced {len(replace) - len(added)}, added {len(added)}, deleted {len(deleted & names)}")
for jp in sorted(replace):
    print(("  + " if jp in added else "  ~ ") + jp)
