# Contributing to zvena

Thank you for wanting to help. Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## Before you start

- **Licensing.** Your changes are contributed under the license of the folder they touch: MPL 2.0 inside `design/src/`, GNU AGPL 3.0 everywhere else ([LICENSING.md](LICENSING.md)). Sign off every commit (`git commit -s`) to certify the [Developer Certificate of Origin](https://developercertificate.org/).
- **Security problems** are never reported in public issues: see [SECURITY.md](SECURITY.md).
- **Big changes** (a new section, a new external service, anything that sends data to a third party) start with an issue or a short written proposal, so the maintainers can agree on the direction before code is written. See [GOVERNANCE.md](GOVERNANCE.md).

## Setting up

```bash
git clone https://github.com/Zvena-app/zvena-oss.git && cd zvena-oss
git fetch origin tag penpot-2.18.3             # Design's build compares against it
cd web && npm ci
npm run dev                                     # http://localhost:3100, env variables: deploy/.env.example
```

Design (the Penpot fork) builds in Docker: `design/bin/build-frontend.sh` and `design/bin/build-backend.sh`; a full stand starts with `deploy/scripts/up.sh` (README, "Test stand and production"). Use fake data only on test stands.

## Making a change

1. Branch from `main`, one topic per branch, and open a pull request.
2. Keep to the style of the surrounding code: same naming, comment density and structure. No unrelated refactors in the same change.
3. Run, in `web/`:
   ```bash
   npm run typecheck && npm run lint && npm test && npm run check:no-ai
   node scripts/i18n.mjs check      # every UI string exists in all 10 languages
   ```
   and the browser suites that cover what you touched (`web/tests/e2e/*.mjs`, see README).
4. **Data and privacy.** If the change collects new personal data, sends anything to a new service, or changes what goes to an existing one (for example the decision model behind smart suggestions), say so in the pull request and in `DEPLOY.md` (operators must update their privacy policies), and add a test that pins what is sent.
5. **Help texts** (`web/src/app/help`) describe what the code does today. A feature behind a flag is not described as available.
6. Write the commit message as what changed and why. Commits made with an AI coding assistant are marked with a `Co-Authored-By:` line; much of zvena's code has been written that way under the maintainers' direction.

## Reviews and releases

Every pull request is reviewed by a maintainer. Changes to sign-in, permissions, sharing or anything that handles other people's data also get a security review.

## Translations

The interface is in 10 languages (English is the source). New strings go into the English dictionary and every catalog under `web/src/i18n/catalogs/`; `node scripts/i18n.mjs check` must pass.
