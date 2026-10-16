# zvena

A free, open-source workspace for teams — design, docs, projects, calendar and mail in one place. This is the software behind [zvena.app](https://zvena.app); you can run your own server with it.

- **Design** — an interface design tool, a fork of [Penpot](https://github.com/penpot/penpot) 2.18.3: components, auto layout, prototypes, inspect mode, real-time collaboration;
- **Docs** — pages and databases (table, board, calendar, timeline, gallery, chart and form views), built on the BlockNote editor;
- **Projects** — an issue tracker: issues, teams, projects, cycles, roadmap, boards, triage, goals, inbox;
- **Calendar and Mail** — calendars with booking pages and CalDAV sync; a mail client for your own IMAP/SMTP mailbox;
- **Teams** — workspaces, invite links, roles (owner, editor, commenter, viewer), single sign-on (SAML, OpenID Connect) and SCIM, shared by every section;
- **Apps** — a browser extension (web clipper), desktop (Electron) and mobile (Capacitor) apps in `clients/`.

No ads and no third-party analytics. People sign in with Google, GitHub, single sign-on or a one-time e-mail link — no passwords.

**AI.** The only AI is an optional decision model — an RLHF architecture and model — for suggestions in Projects and in workspace automations. It is called from the server only, is off unless the server has `ZVENA_AI_URL` and `ZVENA_AI_KEY`, and then works in every workspace whose owner has not turned it off (`ZVENA_AI_DEFAULT=off` makes it opt-in). Its spending is capped per day (`ZVENA_AI_DAILY_QUESTIONS`). What it sends is enforced in one place, `web/src/lib/decide/smart.ts`. `npm run check:no-ai` fails the build if any other AI provider, SDK or key appears.

## License

zvena is free software:

| Part | License |
|---|---|
| `web/`, `clients/`, `deploy/`, `design/bin/`, `design/deploy/`, `design/tools/` and the rest of the code written for zvena | [GNU Affero General Public License 3.0](LICENSE) (`AGPL-3.0-only`) |
| `design/src/` — zvena Design, a modified Penpot | [Mozilla Public License 2.0](design/src/LICENSE), like Penpot itself |
| Third-party code and fonts inside the repository | Their own licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |

If you run a modified zvena for other people over a network, the AGPL requires you to offer them the source of your version: set `ZVENA_SOURCE_URL`, and the `/source` page links to it. The zvena name and logo are not covered by these licenses: see [TRADEMARKS.md](TRADEMARKS.md). Details: [LICENSING.md](LICENSING.md).

## Trying it on your computer

You need [Node.js](https://nodejs.org) 24 or newer and Git. Nothing else: no database server, no keys.

```bash
git clone https://github.com/Zvena-app/zvena-oss.git && cd zvena-oss/web
npm ci
cat > .env.local <<EOF
AUTH_SECRET=$(node -p "require('crypto').randomBytes(32).toString('hex')")
ZVENA_STAND=test
ZVENA_DEV_LOGIN=1
ZVENA_DB_PATH=./data/zvena.db
ZVENA_FILES_DIR=./data/files
EOF
npm run dev
```

Open http://localhost:3100, choose **Sign in as a test user** and type any name. Docs, Projects, Calendar, Mail and the workspace settings all work. Your data stays in `web/data/`, which Git ignores; delete the folder to start over.

- `ZVENA_STAND=test` marks the server as a test server: a banner on every page and nothing indexed by search engines. The test sign-in works only together with it, so never set either one on a real server.
- Design is a separate server (the Penpot fork). It is not part of `npm run dev`, so its links stay off. To get Design too, run the full stack with Docker, as described below.
- Every other setting, such as Google or GitHub sign-in, e-mail and smart suggestions, is in [`deploy/.env.example`](deploy/.env.example).

## Running your own server

[DEPLOY.md](DEPLOY.md) walks through it: one Ubuntu server, Docker Compose, Caddy with automatic HTTPS, backups and monitoring. In short:

```bash
sudo mkdir -p /opt/zvena && cd /opt/zvena
sudo git clone https://github.com/Zvena-app/zvena-oss.git src && cd src
sudo git fetch origin tag penpot-2.18.3     # Design's build compares against it
sudo deploy/scripts/init-env.sh             # /etc/zvena/zvena.env with fresh secrets
sudoedit /etc/zvena/zvena.env               # domains, sign-in keys, mail, your legal pages
sudo deploy/scripts/up.sh
```

zvena ships no Terms of Service or Privacy Policy of its own: publish yours and set `ZVENA_TERMS_URL` and `ZVENA_PRIVACY_URL`.

## Layout

| Folder | What's inside |
|---|---|
| `web/` | Next.js 16: sign-in (Google, GitHub, e-mail, SSO), Docs, Projects (`src/lib/projects`, `src/components/projects`), Calendar, Mail, workspaces and roles, the OIDC provider that signs people into Design, reports and moderation, data export and account deletion, templates, Help, `/status`, `/source` |
| `design/src/` | The Penpot fork. zvena's own code lives in separate modules `app.zvena.*`: backend `management`, `teams`, `limits`; frontend `app.zvena`, `ui/zvena/*`. Changed Penpot files are listed on the `/source` page |
| `design/bin/` | Building Design's images and the source-code archives |
| `design/tools/templates/` | The generator of Design templates from HTML |
| `clients/` | Apps around the web app, each with its own README: `web-clipper/` (Chrome, Edge, Firefox), `desktop/` (Mac, Windows, Linux), `mobile/` (iOS, Android), `brand/` (logo sources) |
| `deploy/` | Docker Compose for a test stand and production (Caddy, HTTPS), `.env.example`, server scripts, the package installer |

The Penpot 2.18.3 snapshot that Design's changes are measured against is the tag `penpot-2.18.3` (its commit is in `design/UPSTREAM`; the tree is identical to Penpot's own tag `2.18.3`).

## Development

```bash
cd web && npm ci
npm run dev                # http://localhost:3100 (env variables: deploy/.env.example)
npm run typecheck && npm run lint
npm test                   # unit and API tests: a temporary database in a temporary folder
npm run check:no-ai        # the decision model is called only from lib/decide/smart.ts
node scripts/i18n.mjs check
```

Design (the Penpot fork) builds in Docker: `design/bin/build-frontend.sh` and `design/bin/build-backend.sh`.

Browser checks run against a running test stand and need `playwright-core` and Chromium:

```bash
BASE=http://localhost:3100 DESIGN=http://localhost:3110 WEB_CONTAINER=<stand>-web-1 \
PLAYWRIGHT_CORE=/path/to/playwright-core node tests/e2e/checklist.mjs   # also smoke, design, consent, projects…
```

A test stand is its own compose project with settings outside Git: `ZVENA_STAND=test` (plain http on localhost; the test sign-in may be enabled with `ZVENA_DEV_LOGIN=1`), started with `ZVENA_ENV=/etc/zvena/<name>.env deploy/scripts/up.sh`. Use fake data only.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), the [Code of Conduct](CODE_OF_CONDUCT.md) and [GOVERNANCE.md](GOVERNANCE.md). Security problems: [SECURITY.md](SECURITY.md), never a public issue.
