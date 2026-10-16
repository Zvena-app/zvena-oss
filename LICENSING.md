# Licensing

Which part of this repository is under which license. This file describes the code as it is; it is not legal advice.

## By folder

| Path | Who wrote it | License |
|---|---|---|
| Everything written for zvena outside `design/src/`: `web/`, `clients/`, `deploy/`, `design/bin/`, `design/deploy/`, `design/tools/`, root documents | Ethan Merker and the zvena contributors | **GNU AGPL 3.0 only** ([LICENSE](LICENSE)); `"license": "AGPL-3.0-only"` in each `package.json` |
| `design/src/` | Penpot 2.18.3 (© Kaleidos INC and contributors) plus zvena's changes and added files | **MPL 2.0** ([design/src/LICENSE](design/src/LICENSE)). Changed Penpot files keep their headers; added files carry the MPL 2.0 header |
| `design/src/frontend/src/app/main/ui/workspace/zvena/fzstd.js` | fzstd 0.1.1, Arjun Barrett | MIT (header in the file) |
| `web/src/components/projects/icons.tsx` (icons) | adapted from Circle | MIT — notice in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |
| Fonts in `web/public/fonts`, `clients/*/fonts`, `design/brand/fonts` | Rasmus Andersson (Inter), Adobe (Source Serif 4, Source Sans) | SIL OFL 1.1 (license file next to each font) |
| npm dependencies of `web/` and `clients/` | their authors | MIT, ISC, BSD, Apache 2.0 and similar; BlockNote MPL 2.0; libvips LGPL 3.0+ (server only). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |
| The zvena name and logos (`web/public/brand`, `clients/brand`) | zvena | Copyright and trademark: see [TRADEMARKS.md](TRADEMARKS.md) |

Copyright (C) 2026 Ethan Merker and the zvena contributors.

## What this means

- You may use, study, change and share zvena under the AGPL 3.0. If you run a modified version for other people over a network, you must offer them the corresponding source of your version (AGPL section 13): set `ZVENA_SOURCE_URL` to where it is published; the `/source` page links to it.
- **Design** may be used, modified and redistributed under the MPL 2.0. If you distribute a modified Design, the MPL's file-level copyleft applies to the files you change. The `/source` page also offers Design's source archives and the patch against Penpot 2.18.3 (`design/bin/publish-source.sh`).
- The MPL 2.0 is compatible with the GNU licenses (it is not marked "Incompatible With Secondary Licenses"), so Design and the AGPL code can be distributed together.

## Contributions

Contributions are accepted under the license of the folder they change (AGPL 3.0, or MPL 2.0 inside `design/src/`). Sign off your commits (`git commit -s`) to certify the [Developer Certificate of Origin](https://developercertificate.org/).
