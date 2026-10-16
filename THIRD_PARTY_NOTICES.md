# Third-party notices

## Zvena Projects

Zvena Projects (`web/src/lib/projects`, `web/src/components/projects`) was
designed after studying two MIT-licensed open-source projects. Their notices
are kept here as their licenses require.

### Circle — status and priority icons

The status icons (backlog, unstarted, started, completed, canceled) and the
priority icons in `web/src/components/projects/icons.tsx` are adapted from
Circle (https://github.com/ln-dev7/circle). The layout ideas of the sidebar,
issue rows, board and create dialog also follow Circle; that code was
rewritten for zvena (no Tailwind, shadcn or mock data were taken over).

```
MIT License

Copyright (c) 2025 lndev-ui | Circle Template

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Kaneo — server-side patterns

Kaneo (https://github.com/usekaneo/kaneo) runs on PostgreSQL with Drizzle;
zvena runs on SQLite, so no Kaneo source code was copied. These patterns were
reimplemented after reading Kaneo's backend:

- a per-team counter for issue numbers;
- one place that derives history and notifications from a before/after diff;
- mentions that notify only when they first appear;
- never notifying people about their own actions;
- access rules expressed as SQL conditions.

The notice is kept as acknowledgement.

```
MIT License

Copyright (c) 2024 Andrej Acevski

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### npm dependencies

The editor uses Tiptap 3.31.4: `@tiptap/react`, `starter-kit`, `markdown`,
`extension-mention`, `suggestion`, `extension-list`, `extensions`,
`extension-image` and `pm`. It also uses `marked`. All of these are MIT; their
license files ship inside `node_modules`.

No proprietary Linear code, logos, trademarks or illustrations are used.

## zvena Design (`design/src/`)

zvena Design is a modified Penpot 2.18.3, © Kaleidos INC and contributors,
under the Mozilla Public License 2.0 (`design/src/LICENSE`). Penpot's license
headers are kept in every file we changed; files we added carry the MPL 2.0
header. The modified source is published at https://zvena.app/source.

### figma-squircle — smooth corner geometry

The corner-smoothing geometry in
`design/src/render-wasm/src/shapes/smooth_corners.rs` and
`design/src/frontend/src/app/main/ui/shapes/attrs.cljs` follows
figma-squircle (https://github.com/phamfoo/figma-squircle).

```
MIT License

Copyright (c) 2021 Tien Pham

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### fzstd — Zstandard decompression for `.fig` import

`design/src/frontend/src/app/main/ui/workspace/zvena/fzstd.js` is fzstd 0.1.1
(https://github.com/101arrowz/fzstd), MIT, Copyright (c) 2020 Arjun Barrett.
Its license header is kept at the top of the file.

## Libraries shipped under copyleft or dual licenses (web)

These are used unmodified from npm; their license files ship inside
`node_modules` and in the built image.

| Package | License | Where the source is |
|---|---|---|
| `@blocknote/core`, `@blocknote/react`, `@blocknote/ariakit` 0.55.0 (the Docs editor) | MPL 2.0 | https://github.com/TypeCellOS/BlockNote/tree/v0.55.0 |
| `dompurify` | MPL 2.0 or Apache 2.0 (used under Apache 2.0) | https://github.com/cure53/DOMPurify |
| `jszip` | MIT or GPL 3.0 (used under MIT) | https://github.com/Stuk/jszip |
| `sharp` with `@img/sharp-libvips-*` (server-side image resizing) | Apache 2.0; libvips LGPL 3.0 or later, dynamically linked | https://github.com/lovell/sharp, https://github.com/libvips/libvips |

All other runtime dependencies of `web/` are under MIT, ISC, BSD, Apache 2.0,
0BSD, MIT-0, BlueOak or the Unlicense (`package-lock.json` lists each one's
license). The fonts (Inter, Source Serif 4, Source Sans) are under the SIL Open
Font License 1.1; the license file sits next to each font.
