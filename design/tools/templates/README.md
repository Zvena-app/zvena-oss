# Design templates

This folder builds `web/templates/design/*.penpot`. The `/templates` gallery shows them, and "Use" imports a template into the workspace (`/api/design/template`).

## How it works

- `html/<key>.html` is the English source of a template (the default); `html/ru/<key>.html` is the Russian copy.
  - Every `<template data-board="Name">` becomes one board.
  - Plain HTML/CSS: flex becomes auto layout, `svg` becomes vectors, text becomes text layers.
  - Font: Source Sans Pro only — Design serves it itself.
- `convert.js` turns the rendered HTML into a layer description (the converter of an earlier design tool, local font only).
- `builder.js` creates the layers through Penpot's plugin API. It runs inside the editor as a built-in plugin and is never installed for users.
- `build.mjs` runs the whole build:
  1. signs in on the test stand with the test sign-in;
  2. creates one file per template;
  3. builds the layers;
  4. exports the file through the management API into `web/templates/design/`.

## Build

Needs a running test stand (web, Design and the Design management API; the ports below are those of a typical test stand).

```bash
set -a; . /etc/zvena/<stand>.env; set +a      # management API key; never print it
BASE=http://localhost:3200 DESIGN=http://localhost:3210 PENPOT_MGMT_URL=http://127.0.0.1:3211 \
PLAYWRIGHT_CORE=/path/to/playwright-core SHOTS=/tmp/shots \
node design/tools/templates/build.mjs                       # English: <key>.penpot
TEMPLATE_LANG=ru … node design/tools/templates/build.mjs     # Russian: <key>.ru.penpot
```

To add a template:

1. Put the HTML into `html/` (and a Russian copy into `html/ru/`).
2. Add its key and names to `NAMES_BY_LANG` in `build.mjs`.
3. Add an entry to `web/src/lib/design-templates.ts`.

All data in the templates is made up. There are no photos: colored rectangles and gradients stand in for them.
