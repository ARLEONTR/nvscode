# nVSCode

[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-green.svg)](nextcloud-app/appinfo/info.xml)
[![Nextcloud](https://img.shields.io/badge/Nextcloud-29--30-blue.svg)](https://nextcloud.com)

Embed VS Code inside Nextcloud. Users open their own files in an isolated browser IDE without leaving the Nextcloud interface. User identity and file ownership stay anchored in Nextcloud.

## Architecture

- The **Nextcloud app** adds an `Open in nVSCode` file action, handles permission checks, translates a selected path into a workspace request, and exposes an admin settings page.
- The **launcher service** (Node.js) manages one `code-server` container per user. Each container mounts only that user's real Nextcloud files directory and persists their editor state separately. Idle containers are stopped automatically.
- A **custom code-server image** ships with `pandoc` 3.9, `typst` 0.14.2, and `tinymist` 0.14.10 preinstalled, so Typst preview and document format conversion (e.g. `pandoc -f typst -t docx`) work out of the box.
- **Caddy** exposes both services on the same origin. Requests under `/apps/nvscode/proxy/...` are routed to the launcher so the IDE appears to live inside Nextcloud and WebSockets keep working.

Design constraints kept explicit:

- Nextcloud is the source of truth for users and files.
- `code-server` is the actual editor runtime.
- User isolation is enforced by per-user containers and per-user file mounts.
- WebSocket proxying happens at the edge, not through PHP.

## Repository layout

```
nvscode/
├── nextcloud-app/          # Nextcloud integration layer (PHP)
├── launcher/               # Node.js launcher and proxy service
├── docker/
│   ├── code-server-base/   # Custom code-server image (Pandoc, Typst, Tinymist)
│   └── caddy/              # Reverse proxy config
├── docker-compose.yml      # Local development stack
├── .env.example            # Configuration template
├── deployment.md           # Guide for integrating into an existing Nextcloud
└── app-store-release.md    # Nextcloud App Store release process
```

The Compose stack keeps `/var/www/html` on a Docker-managed volume so the official Nextcloud image can initialize and update bundled apps. Only Nextcloud user data and the custom app source are bind-mounted from the host.

## Local setup

> To integrate nVSCode into an already-running Nextcloud instead, see [deployment.md](deployment.md).

### Prerequisites

- Docker and Docker Compose
- Ports 8080 available on the host

### Steps

1. Copy `.env.example` to `.env`.
2. Set `NEXTCLOUD_DATA_HOST_PATH` to the absolute path of `docker-data/nextcloud-data` in this workspace.
3. Set `LAUNCHER_STATE_HOST_PATH` to an absolute path for persistent code-server state, e.g. `docker-data/launcher-state`.
4. Start the stack:
   ```bash
   docker compose up --build
   ```
5. Open `http://localhost:8080` and complete the Nextcloud installation if prompted.
6. Enable the app:
   ```bash
   docker compose exec nextcloud php occ app:enable nvscode
   ```
7. Open **Administration settings** → **nVSCode** to adjust defaults if needed.

Once enabled, open Files in Nextcloud, use the file action menu, and select **Open in nVSCode**.

### Default extensions and tools

The launcher reads `CODE_SERVER_DEFAULT_EXTENSIONS` from the environment. Defaults are `myriad-dreamin.tinymist` and `mathematic.vscode-pdf`. Set `CODE_SERVER_FORCE_EXTENSION_UPDATES=true` to reinstall them on every container start so they pick up the latest marketplace version.

The default `CODE_SERVER_IMAGE` is a locally built image (`nvscode-code-server:latest`) that includes Pandoc 3.9, Typst 0.14.2, and Tinymist 0.14.10. PDF files open in an in-editor preview by default.

The default signed session TTL is 1 hour. Treat the iframe URL as a bearer token and avoid extending that TTL unless necessary.

## Tests

```bash
cd launcher
npm install
npm test
```

## Current scope

This is an MVP scaffold, not a finished production package.

- Requires local Docker access for the launcher service.
- Uses short-lived signed proxy URLs issued by the Nextcloud app.
- Persists per-user code-server state on the host filesystem.
- Stops idle editor containers; does not yet implement quota or advanced retention policies.
- Does not yet provision extension policies or richer audit logging.

## Production hardening checklist

- Put Caddy behind real HTTPS before exposing beyond a trusted local network. The development Caddyfile disables automatic HTTPS.
- Treat the launcher as a privileged service — it has Docker socket access and can control containers on the host.
- Keep VS Code session TTLs short unless there is a specific operational reason not to.
- Replace the bootstrap shared secret sync with a dedicated launcher admin handshake so secret rotation does not require a launcher restart.
- Add refreshable session minting so long-lived IDE tabs can recover after token expiry.
- Add admin settings for allowed extensions and resource limits.
- Add richer container retention policies beyond simple idle shutdown.
- Extend tests to cover Nextcloud-side permission checks and settings persistence.

## App Store release

The Nextcloud Community App Store distributes the `nextcloud-app/` folder only. The launcher service, code-server image, and reverse proxy remain external deployment steps documented in [deployment.md](deployment.md).

To prepare an App Store archive:

1. Update `nextcloud-app/appinfo/info.xml` and `nextcloud-app/CHANGELOG.md` for the release version.
2. Run `./scripts/package-nextcloud-app.sh`.
3. Upload the generated `dist/nvscode-<version>.tar.gz` to a GitHub release or another HTTPS host.
4. Sign the archive with your Nextcloud App Store private key and upload the release in the App Store developer portal.

The detailed release flow, including certificate generation and upload steps, is in [app-store-release.md](app-store-release.md).
