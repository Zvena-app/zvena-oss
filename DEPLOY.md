# Deploying zvena

How to run your own zvena server. You run every command yourself on your own server. The repository holds only files — Docker, scripts and this guide. There are no secrets in Git.

> The only outside services the server talks to are:
> - your SMTP server — e-mail (sign-in links, invitations, alerts);
> - your model provider — the optional decision model (an RLHF architecture and model) behind smart suggestions and automations, only when `ZVENA_AI_URL` and `ZVENA_AI_KEY` are set. It receives only the fields listed in `web/src/lib/decide/smart.ts` and its callers; a workspace owner can turn it off;
> - Let's Encrypt — HTTPS certificates;
> - Figma's API — only when someone imports a Figma file into Design with their own access token (never stored);
> - Google Fonts — Design's font catalog, fetched by the server and cached (see "Fonts").
>
> The visitor's browser loads data only from your own domains: fonts are self-hosted and there is no analytics or tracking.

## Contents

0. [Before launch: legal checklist](#0-before-launch-legal-checklist)
1. [What you need](#1-what-you-need)
2. [Preparing the server](#2-preparing-the-server)
3. [DNS](#3-dns)
4. [Installing from the package](#4-installing-from-the-package)
5. [Installing from Git](#5-installing-from-git)
6. [Settings](#6-settings)
7. [Images](#7-images)
8. [First start and HTTPS](#8-first-start-and-https)
9. [Sign-in: e-mail and single sign-on](#9-sign-in-e-mail-and-single-sign-on)
10. [Moderators](#10-moderators)
11. [Backups](#11-backups)
12. [Monitoring and logs](#12-monitoring-and-logs)
13. [Fonts](#13-fonts)
14. [Updates and rollback](#14-updates-and-rollback)
15. [Launch checklist](#15-launch-checklist)
16. [What is stored where](#16-what-is-stored-where)
17. [Custom domains for sites, SSO and SCIM](#17-custom-domains-for-sites-sso-and-scim)
18. [The hub: what runs by itself](#18-the-hub-what-runs-by-itself)

## 0. Before launch: legal checklist

This is not legal advice. Go through every item with a lawyer **before** the first real users arrive.

1. **Who runs the server.** You do. Set `ZVENA_COMPANY_NAME` and the contact addresses (`ZVENA_CONTACT_EMAIL`, optionally `ZVENA_SUPPORT_EMAIL`, `ZVENA_PRIVACY_EMAIL`, `ZVENA_ABUSE_EMAIL`), and make sure someone reads them.
2. **Your Terms of Service and Privacy Policy.** zvena ships no legal text of its own. Publish yours and set `ZVENA_TERMS_URL` and `ZVENA_PRIVACY_URL`; `/legal/terms` and `/legal/privacy` send people there. `/legal/cookies` describes the cookies the software sets (`web/src/app/legal/cookies/page.tsx`). When your documents change materially, move `ZVENA_CONSENT_VERSION` to that day's date: signed-in people then accept them again.
3. **Service providers.** List the providers that handle personal data for you (hosting, a CDN or proxy if used, your SMTP server, your model provider if you set `ZVENA_AI_URL` and `ZVENA_AI_KEY`) in your Privacy Policy, with the agreements your law requires.
4. **Smart suggestions (the decision model).** With `ZVENA_AI_URL` and `ZVENA_AI_KEY` set, smart suggestions send issue, comment and document text (which can mention people) to your model provider, on by default in every workspace; `ZVENA_AI_DEFAULT=off` makes it opt-in. What is sent is fixed in `web/src/lib/decide/smart.ts`. Without them nothing is sent.
5. **Reports and moderation.** The report queue is at `/admin`. Appoint a moderator (section 10) and answer reports within the time your policies promise.
6. **Source code (AGPL 3.0).** If you change zvena, people who use your server must be able to get the source of the version you run: publish it and set `ZVENA_SOURCE_URL`; the `/source` page links to it.

## 1. What you need

- **A server**: Ubuntu 24.04 or 22.04 LTS, 4 vCPU, 8 GB RAM, an SSD of 80 GB or more. Choose the server's location to match what your Privacy Policy says about where data is stored.
  - Building Design on the server itself needs about 15 GB more disk and 8 GB of free memory for the build. Without that, build the images on another machine (section 7).
- **The domain** `example.com` with three names pointing to the server: `example.com`, `www.example.com` and `design.example.com` (section 3).
- **The source**: `git clone https://github.com/Zvena-app/zvena-oss.git` if you install from Git. Installing from a package needs no GitHub at all (section 4).
- **An SMTP server** for e-mail: your own or your mail provider's (section 9).

## 2. Preparing the server

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install ca-certificates curl git gnupg rsync python3 openssl unattended-upgrades ufw
# Docker from Docker's own repository (docs.docker.com/engine/install/ubuntu/)
# or from Ubuntu's:
sudo apt -y install docker.io docker-compose-v2 docker-buildx
sudo systemctl enable --now docker

# Firewall: SSH and the web only
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp
sudo ufw enable
```

Two more steps:

- **SSH**: key-only sign-in (`PasswordAuthentication no` in `/etc/ssh/sshd_config`, then `sudo systemctl reload ssh`). Make sure your key works before you switch passwords off.
- **Docker Hub**: if it is unreachable from the server, configure the registry mirror your hosting provider offers (`/etc/docker/daemon.json` → `"registry-mirrors"`, then `systemctl restart docker`), or install from a package (section 4), which needs no registry.

## 3. DNS

Create three records, all pointing to the server's IP address (add `AAAA` records as well if the server has IPv6):

| Name | Type | Value |
|---|---|---|
| `example.com` | A | server IP |
| `www.example.com` | A | server IP |
| `design.example.com` | A | server IP |

`www.example.com` redirects to `example.com`; `design.example.com` serves Design.

**Behind a CDN proxy** (Cloudflare's orange cloud, for example):

- Set **SSL/TLS → Overview → encryption mode** to **Full (strict)** (or **Full**). Never **Flexible**: Caddy redirects HTTP to HTTPS, and with Flexible Cloudflare talks HTTP to the server, which ends in an endless redirect loop.
- Let's Encrypt's HTTP-01 check works through the proxy as long as requests to `/.well-known/acme-challenge/` reach the server over plain HTTP. Do not add a Cloudflare rule that blocks or rewrites that path. (Cloudflare's "Always Use HTTPS" leaves the ACME path alone.)
- All three names must be proxied the same way and point to the same server. If one name points elsewhere, Caddy cannot get its certificate and keeps retrying.
- After you add or fix a DNS record, Caddy retries on its own; to retry at once, restart it: `cd /opt/zvena/src/deploy && sudo docker compose --env-file /etc/zvena/zvena.env -f docker-compose.yml -f docker-compose.prod.yml restart caddy`.

Custom domains of published sites need two more records, **not** proxied — see section 17.

## 4. Installing from the package

A package is one `.tar` with the source (a Git bundle), ready Docker images for the server's platform and `install.sh`. The server needs neither GitHub nor Docker Hub. To build one on a machine where the images are built (section 7):

```bash
ZVENA_ENV=/path/to/settings deploy/scripts/make-package.sh /folder/for/package               # linux/amd64
ZVENA_ENV=/path/to/settings deploy/scripts/make-package.sh /folder/for/package linux/arm64
```

This creates the folder `zvena-server-<version>-amd64/` and its `.tar` archive with:

- the source (Git bundle: this commit and the tag `penpot-2.18.3`);
- the images for the server's platform (the script checks that they really are built for it);
- `install.sh`, a short README and this guide.

There are no secrets in a package. On the server:

```bash
scp zvena-server-*.tar root@<IP>:/root/
ssh root@<IP>
tar -xf zvena-server-*.tar && cd zvena-server-*/
sudo ./install.sh --domain example.com   # source, settings, images (sections 5–7)
sudo nano /etc/zvena/zvena.env         # section 6
sudo ./install.sh --start              # section 8, the first backup, cron from sections 11 and 12
```

`install.sh` installs Docker itself when it is missing. Do the rest of section 2 (SSH, firewall) yourself.

`install.sh` puts the source into `/opt/zvena/src`, creates `/etc/zvena/zvena.env` with fresh secrets, and loads the images. With `--start` it also starts the service, waits until it is healthy, makes the first backup and writes the nightly backup and the health check to `/etc/cron.d/zvena`. It is safe to run again: the source, the settings and loaded images are kept.

A new version installs the same way: bring the new package and run its `install.sh --start`. It makes a backup first, then moves the source forward, loads the new images and restarts the service.

## 5. Installing from Git

```bash
sudo mkdir -p /opt/zvena && cd /opt/zvena
sudo git clone https://github.com/Zvena-app/zvena-oss.git src && sudo git -C src fetch origin tag penpot-2.18.3
```

Do not clone with `--depth`: building Design and the "Source code" page need the tag `penpot-2.18.3` (the Penpot 2.18.3 snapshot that the changes are measured against). Check: `git cat-file -t "$(cat design/UPSTREAM)"` answers `commit`.

**Releases** are tags (`v1.0.0`, …) of the public repository [Zvena-app/zvena-oss](https://github.com/Zvena-app/zvena-oss); no prebuilt images are published. To install a release, clone it as above, `git checkout v<version>`, and build the images (section 7). A release's `zvena-<version>-src.tar.gz` and `SHA256SUMS` (made from the tag by `tools/release/make-assets.sh`, reproducibly) are there to check and archive the exact source: `build-images.sh` and Design's build need the Git clone (the tag `penpot-2.18.3`), not the tarball.

From here on, all paths are relative to `/opt/zvena/src`.

## 6. Settings

```bash
sudo deploy/scripts/init-env.sh
sudo nano /etc/zvena/zvena.env
```

The script creates `/etc/zvena/zvena.env` with fresh secrets and the backup passphrase file `/etc/zvena/backup.pass`, both with mode 600. (`install.sh` runs it for you.)

In `zvena.env` fill in:

- the domains and `ACME_EMAIL`;
- the company details and contact inboxes (section 0);
- your SMTP server (section 9);
- `ZVENA_ADMIN_EMAIL` (new reports) and `ALERT_EMAIL` (outages);
- `ZVENA_MAPS_CONTACT` (an e-mail or URL of yours) while maps use OpenStreetMap's public servers (the default): their tile and Nominatim policies require a contact, and without one heavy use gets the server's address blocked — the web app's log warns at start-up while it is empty. Tiles fetched from the map server are capped per person and for the whole server per day (`ZVENA_MAPS_TILES_PER_USER_DAY`, 5000; `ZVENA_MAPS_TILES_PER_DAY`, 50000; cached tiles don't count). For heavy use point `ZVENA_TILES_URL` / `ZVENA_GEOCODER_URL` at your own server or a provider.

Every line is described in `deploy/.env.example`. Visitors without an account may upload pictures only, within `ZVENA_GUEST_UPLOAD_MB*`; anything else needs an account, and uploaded files can be reported and taken down like pages.

**Keep a copy of `/etc/zvena/backup.pass` and of `/etc/zvena/zvena.env` away from the server**, for example in a password manager. Neither is inside the backups:

- without `backup.pass` the backups cannot be decrypted;
- without `AUTH_SECRET` (in `zvena.env`) a restored server cannot open what zvena keeps sealed in its database — workspaces' SSO client secrets, connected mailboxes' IMAP/SMTP passwords, CalDAV and booking secrets. A fresh `init-env.sh` makes a new `AUTH_SECRET`, and every SSO login, mailbox and calendar connection then has to be set up again. Keep `DESIGN_SECRET_KEY`, `PG_PASSWORD`, `DESIGN_OIDC_CLIENT_SECRET`, `DESIGN_MGMT_KEY` and `ZVENA_INTERNAL_KEY` with it (the simplest: the whole file).

After any change to `zvena.env`: `sudo deploy/scripts/up.sh`.

## 7. Images

### Building on the server

```bash
sudo deploy/scripts/build-images.sh
```

The script builds three images from the current commit:

- web;
- Design's backend: the official Penpot 2.18.3 image with the modified sources;
- Design's frontend: built in Penpot's official `penpotapp/devenv` image, which takes 30–60 minutes.

It also prepares the archives for the "Source code" page (MPL 2.0) and writes the image tags into `zvena.env`.

### Building on another machine

On any machine with Docker and the same commit:

```bash
ZVENA_ENV=/path/to/settings deploy/scripts/build-images.sh
ZVENA_ENV=/path/to/settings deploy/scripts/save-images.sh /tmp
```

This creates `zvena-images-<version>.tar.gz` and its `.sha256`. Copy both to the server (scp) and load them:

```bash
sudo deploy/scripts/load-images.sh /root/zvena-images-<version>.tar.gz
```

Or wrap everything into a package (section 4).

## 8. First start and HTTPS

The DNS records from section 3 must already point to the server, and ports 80 and 443 must be open. Then:

```bash
sudo deploy/scripts/up.sh
```

(`install.sh --start` does this for you.) On the first request Caddy gets Let's Encrypt certificates for `example.com`, `design.example.com` and `www.example.com` and renews them later on its own.

Check:

- `https://example.com` — the home page;
- `https://example.com/status` — every part says "Operational" (web, database, files, Design, e-mail);
- `https://example.com/source` — the source archives of Design (MPL 2.0);
- `https://example.com/signin` — e-mail sign-in once SMTP is set (section 9), and single sign-on. Without SMTP the page says e-mail sign-in is not set up yet.

## 9. Sign-in: e-mail and single sign-on

There are no passwords. A person types their e-mail and gets a letter with a one-time link and a 6-digit code (valid for 15 minutes, used once). Workspaces can add their own identity provider (OIDC or SAML, section 17).

E-mail goes through any SMTP server — your own or your mail provider's. In `zvena.env`:

```
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=0          # 1 for port 465 (TLS from the start)
SMTP_USER=…
SMTP_PASS=…
SMTP_FROM="zvena <noreply@example.com>"
```

Then `sudo deploy/scripts/up.sh`. Publish SPF and DKIM records for the sending domain as your mail provider describes, or letters land in spam. The same server sends report notices to moderators (`ZVENA_ADMIN_EMAIL`) and outage alerts (`ALERT_EMAIL`, section 12).

Everything the app mails goes through one budget: `ZVENA_MAIL_PER_HOUR` (500) and `ZVENA_MAIL_PER_DAY` (3000) letters for the whole server, however many accounts there are. Past 80% of either only sign-in letters still go out, so people can sign in while invitations are paused; the log says when the budget is used up. Page invitations by e-mail also have a server-wide daily cap (`ZVENA_INVITE_MAIL_PER_DAY`, 1000) and carry no user text in their subject. Sign-in letters are limited to 5 an hour and 12 a day per address.

Accounts: the e-mail link and single sign-on that report the same verified address lead to one account.

## 10. Moderators

1. Sign in to the site with your own account.
2. Run:

   ```bash
   sudo deploy/scripts/make-admin.sh            # the latest accounts: id, date, name
   sudo deploy/scripts/make-admin.sh <your id>  # give the moderator role
   sudo deploy/scripts/make-admin.sh <id> --remove
   ```

The report queue is at `https://example.com/admin`. Moderators get an e-mail about each new report at `ZVENA_ADMIN_EMAIL` when e-mail is configured.

## 11. Backups

```bash
sudo crontab -e
# every day at 03:30
30 3 * * * /opt/zvena/src/deploy/scripts/backup.sh >> /var/log/zvena-backup.log 2>&1
```

If you installed from a package, `install.sh --start` has already written this to `/etc/cron.d/zvena`.

A backup contains:

- Design's database (PostgreSQL);
- the web app's database (SQLite);
- Docs files;
- Design's files (unless they live in S3).

How it is kept:

- encrypted (GPG, AES-256) in `/var/backups/zvena` (`BACKUP_DIR`; one folder per instance: `backup.sh` refuses a folder that holds another instance's backups, since old archives and the last-backup time that monitoring checks are kept per folder);
- for `BACKUP_KEEP_DAYS` days (14 by default);
- copied off-site if `BACKUP_RSYNC_TARGET` (rsync over SSH) or `BACKUP_RCLONE_REMOTE` (S3 through rclone) is set. Keep the off-site copy where your Privacy Policy says the data is stored. New archives are only **added** there (`rsync --ignore-existing`, `rclone copy --immutable`), never mirrored: an emptied, encrypted or wrong local folder cannot wipe the off-site copies. Off-site copies older than `BACKUP_REMOTE_KEEP_DAYS` (30 by default, 0 = never) are pruned separately, by the date in their name, and only after that day's backup succeeded. Better still: a bucket with versioning or object lock, and credentials that can write but not delete.

Once a month, test a restore on a separate test server (section 14).

Restoring on a new server (the old one is gone):

1. Install zvena as in sections 2–5, but **don't run `init-env.sh`**: put your saved `zvena.env` at `/etc/zvena/zvena.env` and `backup.pass` at `/etc/zvena/backup.pass` (both `chmod 600`).
2. Copy the newest archive from the off-site copy to `/var/backups/zvena/`.
3. Start once (`sudo deploy/scripts/up.sh`), then `sudo deploy/scripts/restore.sh /var/backups/zvena/zvena-<time>.tar.gpg`. On an empty new server there is nothing to save first: if the safety backup fails there, add `--i-have-no-backup`.
4. Point DNS at the new server (section 3) and check sign-in, a document, a design, a connected mailbox.

If Design's files live in S3 (`docker-compose.s3.yml`), turn on versioning and replication in the bucket: the script copies only the databases and Docs files.

## 12. Monitoring and logs

```bash
sudo crontab -e
*/5 * * * * /opt/zvena/src/deploy/scripts/monitor.sh >> /var/log/zvena-monitor.log 2>&1
```

If you installed from a package, `install.sh --start` has already written this to `/etc/cron.d/zvena`.

Every 5 minutes `monitor.sh` checks:

- the app's health (`/api/health`: web, database, files, Design, e-mail) — its `ok` (and HTTP 200/503) is readiness: false when the database, the files volume or Design is down; a part that only works with limits (the files volume short of `ZVENA_MIN_FREE_BYTES`, mail whose last letter or SMTP login failed) leaves `ok` true but is reported as `degraded` here and on the status page (`status`: operational / degraded / partial_outage / major_outage). E-mail reads `unverified` while it is set up but nothing has shown yet that it works: a letter that went out or, for SMTP, a login check (never a letter) at most every 30 minutes;
- both public HTTPS addresses (`APP_URL`, `DESIGN_URL`);
- free disk space;
- the age of the last backup.

When the state changes (outage / back to normal) it e-mails `ALERT_EMAIL` through SMTP. The new state is saved only once that letter went out, so an alert that failed is sent again on the next run. The SMTP password reaches `curl` through a config on a file descriptor, never on its command line. The public status page is `https://example.com/status`.

Logs:

- **Service logs**: `cd /opt/zvena/src/deploy && sudo docker compose --env-file /etc/zvena/zvena.env -f docker-compose.yml -f docker-compose.prod.yml logs --tail 200 web`. Rotated at 20 MB × 5.
- **Caddy's request log**: the `caddy-data` volume, file `logs/access.log`, kept 30 days. IP addresses are cut to /16; cookies, the Authorization header and the Referer are removed; a URL keeps its shape but every private link's secret (invite, share, booking, RSVP and calendar-feed tokens, public form and published-page ids, file hashes, signed links) and every query value that carries a secret or what someone typed (`code`, `state`, `token`, `next`, `sig`, `q`, `email`, …) reads `***`. Caddy's own log (`docker compose logs caddy`, where a failed request appears too) goes through the same filter. `deploy/caddy/test-log-masking.sh` (docker) proves it against the real Caddyfile.
- **Design's nginx** (`logs design-frontend`) writes the path without its query string and without the Referer.
- **The web app** logs only counters and error codes, never names, e-mail addresses or content.

## 13. Fonts

Design offers the full Google Fonts catalog, as Figma does. The browser never talks to Google: the `design-frontend` container fetches fonts on the server and keeps them for years on the `fonts-cache` volume (`/opt/data/gfonts`), so cached fonts keep working if Google becomes unreachable. To pre-fill the cache after the first start:

```bash
sudo deploy/scripts/warm-fonts.sh                 # ~65 most used families (Inter, Roboto, Open Sans, Montserrat, Poppins…)
sudo deploy/scripts/warm-fonts.sh --cyrillic      # families with Cyrillic
sudo deploy/scripts/warm-fonts.sh --all           # the whole catalog (several GB)
sudo deploy/scripts/warm-fonts.sh Inter Roboto    # named families
```

## 14. Updates and rollback

From Git:

```bash
sudo deploy/scripts/update.sh
# or with images built on another machine:
sudo deploy/scripts/update.sh --images /root/zvena-images-<version>.tar.gz
```

`update.sh` does four steps:

1. a backup;
2. `git pull`;
3. building the images (or loading them);
4. restarting and checking health.

From a package: run the new package's `install.sh --start` (section 4).

Rolling back to the previous images:

```bash
sudo cp /etc/zvena/zvena.env.prev /etc/zvena/zvena.env && sudo deploy/scripts/up.sh
```

If the data must go back too:

```bash
sudo deploy/scripts/restore.sh /var/backups/zvena/zvena-<time>.tar.gpg
```

`restore.sh`:

- asks for confirmation (type `RESTORE`; `--yes` skips this);
- first makes a backup of the current state — if that fails, nothing is changed: it asks again (type `NO-BACKUP`), and with `--yes` it stops; only `--i-have-no-backup` restores without one;
- then replaces the data with the backup (PostgreSQL in one transaction: a dump that does not load stops the restore) and checks the service's health.

## 15. Launch checklist

- [ ] `/status`: every part is "Operational"; the certificates are valid (padlock in the browser) for `example.com`, `www.example.com` (redirects) and `design.example.com`.
- [ ] Sign in with an e-mail link (both the link and the 6-digit code).
- [ ] The sign-in e-mail arrives in the inbox (not spam) and comes from `SMTP_FROM`.
- [ ] Create a workspace, invite by link, the roles "editor", "commenter" and "viewer".
- [ ] A design in Design, a live frame inside a doc.
- [ ] Publish a page, report it, take it down in `/admin`.
- [ ] Export your data (Settings → "Download all my data") and delete a test account.
- [ ] A backup exists, the off-site copy exists, a test restore worked.
- [ ] The monitoring e-mail arrives: for example, stop `web` for a minute at a quiet time.
- [ ] The legal items from section 0 are done (company details only if a company exists).

## 16. What is stored where

For the Privacy Policy and data-protection requests.

| Data | Where | How long |
|---|---|---|
| Account: name, verified e-mail (from the e-mail sign-in or single sign-on), the single sign-on account id, sign-in times, the Terms version accepted and when. Profile pictures are not stored | web app's SQLite, volume `web-data` | while the account exists; deleted at once from Settings |
| E-mail sign-in links and codes (HMACs only) | SQLite | 15 minutes or until used; expired ones are cleared hourly |
| Docs, comments, Docs files | SQLite and `web-data/files` | while the workspace or the account exists |
| Designs and their files | PostgreSQL, volume `assets` (or S3) | while the team exists; after deletion 30 days in Penpot's trash |
| Sessions (HMACs of the tokens) | SQLite | 30 days after the last renewal (renewed while in use) |
| Guest files | `web-data/files` | `ZVENA_GUEST_FILE_TTL_DAYS` (30) after upload, or sooner when the guest stops visiting (Docs shows guests the date) |
| Security journal: ids and actions, no content | SQLite | 1 year |
| Workspace security settings, verified domains, site domain claims, SSO settings (OIDC client secret sealed with a key derived from `AUTH_SECRET`), SCIM tokens (HMACs only) | SQLite | while the workspace exists |
| SSO sign-ins in flight, SAML request ids, used assertion ids | SQLite | 10–15 minutes |
| Reports: page address, reason, text, optional contact | SQLite | kept with the moderator's decision; the reporter's account link is removed when that account is deleted |
| Request log (IP cut to /16) | volume `caddy-data` | 30 days |
| Backups (encrypted) | `/var/backups/zvena` and the off-site copy | `BACKUP_KEEP_DAYS` (14) locally, `BACKUP_REMOTE_KEEP_DAYS` (30) off-site; any further copy you keep (an offline disk) must match what the Privacy Policy says |

## 17. Custom domains for sites, SSO and SCIM

Workspace owners find these in **Settings**: Security, Identity (verified domains, single sign-on, SCIM), Audit log and Sites. Nothing needs to be set on the server for Security, Identity and the Audit log. Custom domains need DNS and the Caddy configuration from `deploy/caddy/Caddyfile`.

### Custom domains for published sites

A workspace owner connects `docs.example.com` to a published page in **Settings → Sites**. The workspace owner proves the domain with either record that zvena shows them:

- **CNAME** `docs.example.com` → `zv-<claim>.sites.example.com` (a name of their own under `ZVENA_SITES_CNAME`, so a CNAME left dangling cannot be claimed by someone else), or
- **TXT** `_zvena-site.docs.example.com` = `zvena-site=<token>`, for a root domain whose A record points at the server.

On your server, once:

1. DNS (Cloudflare): `sites.example.com` **A** server IP and `*.sites.example.com` **A** server IP (plus AAAA with IPv6), both **DNS only (grey cloud)**. A proxied record cannot work: Cloudflare would answer for the customer's host name itself.
2. Caddy: the `Caddyfile` in this repository already has the pieces — the global `on_demand_tls { ask http://web:3100/api/sites/domain-check }`, the catch-all `https://` site with `tls { on_demand }`, and the `http://` redirect. The ask endpoint answers 200 only for a verified domain whose page is published, not taken down and in a workspace that allows publishing; Caddy then gets a Let's Encrypt certificate on the first HTTPS request (TLS-ALPN-01, port 443 open to the internet). It is answered 404 on the public site, so only Caddy (inside the Docker network) uses it.
3. The web app: `ZVENA_SITES_CNAME` (default `sites.example.com`). Its proxy treats every host that is not `APP_URL`'s host (or `www.` of it), an IP address, `localhost` or a one-label container name as a custom domain: such a host serves the site's page at `/`, its `robots.txt` and `sitemap.xml`, the page's files and map tiles, and **404 for everything else**; no cookie goes in or out. If the app is reached under other first-party names (a stand, an internal name with dots), list them in `ZVENA_APP_HOSTS` (comma-separated). `ZVENA_SITES_HOST_ROUTING=off` turns host routing off altogether (every host is zvena again) — the rollback switch.

4. The switch: `ZVENA_SITES_CUSTOM_DOMAINS=on`. **Off by default**: Settings has no Sites section, `/api/ws/site-domains` and the ask endpoint answer 404, and no host serves a site — so nobody is offered a domain the server cannot serve yet. Turn it on only after steps 1 and 2 are live.

Roll-out: deploy the web image first (host routing is safe without any DNS), then add the two DNS records, then put the new `Caddyfile` in place and `docker compose … restart caddy`, then set `ZVENA_SITES_CUSTOM_DOMAINS=on` and restart the web container. Check: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/api/sites/domain-check?domain=unknown.example` → `404`. Rollback: the previous `Caddyfile` and a Caddy restart; certificates already issued simply expire.

### Single sign-on (SAML 2.0, OpenID Connect) and SCIM

Per workspace, set up by its owner in **Settings → Identity** after verifying a domain with a TXT record. The values to give the identity provider are shown there:

- SAML: entity ID `https://example.com/api/sso/saml/<workspace>/metadata` (also the SP metadata URL), ACS `https://example.com/api/sso/saml/<workspace>/acs`;
- OIDC: redirect URI `https://example.com/api/sso/oidc/<workspace>/callback`; the issuer must be HTTPS (Entra ID: the tenant's own `https://login.microsoftonline.com/<tenant>/v2.0`);
- SCIM: base URL `https://example.com/scim/v2`, a bearer token generated there (shown once).

The server must reach the identity provider over HTTPS for OIDC (discovery, keys, token endpoint; private and loopback addresses are refused). SAML needs no outgoing connection. "Require SSO" never locks out a workspace's owners: they keep their other sign-in methods.

## 18. The hub: what runs by itself

The hub (`web/src/lib/decide/hub.ts`) starts with the web server and needs no setup. Without any key it already runs the exact rules:

- a goal is an issue that closes by itself when its number reaches the target. The number can come from a Docs database or chart, a project's progress, the meetings of a calendar, one's own mail (seen only by its owner), a number typed in, or a number sent from outside (below);
- a parent issue closes with its last sub-issue and reopens with one;
- an issue made from a Design comment closes when the comment is resolved in Design. This uses Design's bridge: the `enable-zvena-bridge` flag (on in `deploy/docker-compose.yml`) and `ZVENA_INTERNAL_KEY`, which `init-env.sh` creates;
- an issue made from a meeting keeps its due date on the meeting's day;
- Docs database automations run on the server, and every run is listed on Home under "Done automatically", with Undo.

Workspace owners turn each rule off on Home → Automations → the settings button.

**Connecting the decision model (optional).** Smart suggestions use an optional decision model — an RLHF architecture and model — called from the server only. With it, goals are proposed and set from issue titles, a new issue's priority, label and project are filled in, and automations set to "Run only if …" are checked. It is off unless both the endpoint and the key are set. To connect it:

1. Put your model provider's endpoint and key in `/etc/zvena/zvena.env`:
   ```bash
   ZVENA_AI_URL=https://…       # the provider's endpoint (no default)
   ZVENA_AI_KEY=…
   ZVENA_AI_MODEL=              # optional: the model version to ask for (empty = the provider's default)
   ZVENA_AI_TIMEOUT_MS=1500
   ZVENA_AI_DEFAULT=on          # off: nothing is sent until a workspace owner turns it on
   ZVENA_AI_DAILY_QUESTIONS=20000     # the spending budget: questions a day in all…
   ZVENA_AI_WS_DAILY_QUESTIONS=1000   # …per workspace…
   ZVENA_AI_DAILY_PER_OWNER=2000      # …and for all of one person's workspaces; over it, rules alone until the next UTC day
   ```
2. Run `sudo deploy/scripts/up.sh`.
3. Check: Projects → Settings → Smart suggestions shows the switch instead of "Not available on this server".

What leaves the server is fixed in one place, `web/src/lib/decide/smart.ts` and its callers (list those fields in your Privacy Policy). Only that file may call the model; `npm run check:no-ai` fails the build otherwise. Fields that name a person, mail, files and designs are never sent. If the endpoint or key is removed, or the provider is down, everything above keeps working on rules alone.

**Numbers from outside.** On Home → Automations → settings, the owner creates a key, which is shown once. With it, a script, a CRM or an analytics tool sends numbers:

```bash
curl -X POST https://<your domain>/api/pulse/ingest \
  -H "Authorization: Bearer zvi_…" -H "content-type: application/json" \
  -d '{"metric":"mrr","value":4200,"label":"MRR"}'
```

Goals on that number close by themselves when it gets there. Revoking the key in the same place stops it at once.
