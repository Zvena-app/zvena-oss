# zvena — server package

Everything needed to install zvena on a clean server. The server needs neither GitHub nor Docker Hub.

| File | What it is |
|---|---|
| `install.sh` | the installer |
| `DEPLOY.md` | the full guide (the same as in the source) |
| `zvena-src.bundle` | the source code (Git: branch `main` and the Penpot snapshot tag) |
| `zvena-images-*.tar.gz` | ready Docker images: web, Design, PostgreSQL, Valkey, Caddy |
| `package.env` | version, platform and image tags |
| `SHA256SUMS` | checksums |

## Server

- Ubuntu 24.04 or 22.04, a CPU of the platform named in `package.env` (usually `linux/amd64`).
- 4 vCPU, 8 GB RAM, an SSD of 80 GB or more.
- Hosting in the EU, where the Privacy Policy says data lives (see `DEPLOY.md`, sections 0 and 1).
- The installer sets up Docker itself if it is missing.

## Installing

1. Copy the archive to the server:

   ```bash
   scp zvena-server-*.tar root@<IP>:/root/
   ```

2. On the server, unpack and install:

   ```bash
   tar -xf zvena-server-*.tar
   cd zvena-server-*/
   sudo ./install.sh --domain example.com
   ```

   What `install.sh` does:
   - puts the source into `/opt/zvena/src`;
   - creates the settings `/etc/zvena/zvena.env` with fresh secrets;
   - loads the images.

3. Fill in `/etc/zvena/zvena.env`:
   - the company details (`ZVENA_COMPANY_*`, `ZVENA_GOVERNING_LAW`);
   - your SMTP server (`SMTP_*`). **Without it nobody can sign in by e-mail** (`DEPLOY.md`, section 9);
   - `ZVENA_ADMIN_EMAIL`, `ALERT_EMAIL`.

4. In DNS, point the A records `example.com`, `design.example.com` and `www.example.com` to the server's IP (behind a CDN proxy, use full TLS to the server — `DEPLOY.md`, section 3). Open ports 80 and 443:

   ```bash
   sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp
   ```

5. Start:

   ```bash
   sudo ./install.sh --start
   ```

   This step:
   - starts the service and waits until it is healthy;
   - Caddy gets the HTTPS certificates;
   - makes the first backup;
   - turns on nightly backups and the health check (`/etc/cron.d/zvena`).

Check: open `https://example.com/status`.

**Keep a copy of `/etc/zvena/backup.pass` away from the server.** Backups cannot be decrypted without it.

## Later

- **Changing settings**: after editing `zvena.env`, run `sudo /opt/zvena/src/deploy/scripts/up.sh`.
- **A new version**: bring the new package and run its `install.sh --start`. It:
  1. makes a backup;
  2. updates the source;
  3. loads the new images and restarts the service.

  Rollback: `sudo cp /etc/zvena/zvena.env.prev /etc/zvena/zvena.env && sudo /opt/zvena/src/deploy/scripts/up.sh`.
- **Everything else** — moderators, backups, logs, the legal checklist — is in `DEPLOY.md`.
