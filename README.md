# nVSCode

This repository contains an MVP for embedding nVSCode inside Nextcloud while keeping user identity and file ownership anchored in Nextcloud.

## Architecture

- The Nextcloud app is responsible for user-facing navigation, permission checks, and translating a selected Nextcloud path into a workspace request.
- The Nextcloud app also exposes an admin settings page so launcher URL, shared secret, session TTL, idle timeout, and the preferred code-server image can be managed inside Nextcloud.
- A launcher service manages one code-server container per Nextcloud user. Each container mounts only that user's real Nextcloud files directory.
- The launcher also persists each user's editor state under a separate host path and stops idle containers on a cleanup interval.
- The stack builds a custom code-server base image with `typst` and Pandoc 3.9 preinstalled.
- The launcher installs a configurable default extension set into each user workspace, currently including Tinymist for Typst support.
- Caddy exposes both services on the same origin. Requests under `/apps/nvscode/proxy/...` are routed to the launcher so the IDE appears to live inside Nextcloud.

This design keeps the difficult parts explicit:

- Nextcloud remains the source of truth for users and files.
- code-server remains the actual editor runtime.
- WebSockets keep working because proxying happens at the edge, not through PHP.
- User isolation is enforced by per-user containers and per-user file mounts.

## Repository layout

- `nextcloud-app/`: custom Nextcloud app mounted as `custom_apps/nvscode`
- `launcher/`: Node.js service that provisions and proxies code-server containers
- `docker-compose.yml`: local development stack

The Compose stack intentionally keeps `/var/www/html` on a Docker-managed volume so the official Nextcloud image can initialize and update bundled apps. Only Nextcloud user data and the custom app source are bind-mounted from the host.

## Local setup

If you want to integrate nVSCode into an already-running Nextcloud instead of using the demo stack here, see [deployment.md](deployment.md).

1. Copy `.env.example` to `.env`.
2. Set `NEXTCLOUD_DATA_HOST_PATH` to the absolute path of `docker-data/nextcloud-data` in this workspace.
3. Set `LAUNCHER_STATE_HOST_PATH` to an absolute path for persistent code-server state, for example `docker-data/launcher-state`.
4. Start the stack with `docker compose up --build`.
5. Open `http://localhost:8080` and finish the Nextcloud installation if prompted.
6. Enable the app inside the Nextcloud container with `docker compose exec nextcloud php occ app:enable nvscode`.
7. In Nextcloud, open Administration settings and configure the nVSCode section if you want values different from the defaults.

Once enabled, open Files in Nextcloud, use the file action menu, and select Open in nVSCode.

The launcher reads `CODE_SERVER_DEFAULT_EXTENSIONS` from the environment. By default it includes `myriad-dreamin.tinymist` and `mathematic.vscode-pdf`.
The default `CODE_SERVER_IMAGE` is a locally built image named `nvscode-code-server:latest` that includes `typst` and Pandoc 3.9, so `pandoc -f typst -t docx` and other Typst conversions are available inside the editor runtime.
PDF files are associated with the PDF viewer custom editor by default, so opening a `.pdf` in nVSCode opens an in-editor preview instead of raw binary content.
The default signed nVSCode session TTL is 1 hour for new installs. Treat the iframe URL as a bearer token and avoid extending that TTL unless you need to.


## Current scope

This is an MVP scaffold, not a finished production package.

- It assumes local Docker access for the launcher service.
- It uses short-lived signed proxy URLs issued by the Nextcloud app.
- It persists per-user code-server state on the host.
- It stops idle editor containers, but it does not yet implement more advanced retention and quota policies.
- It does not yet provision extensions, policies, or richer audit logging.

## Production hardening checklist

- Put Caddy behind real HTTPS before exposing this stack beyond a trusted local network. The current development Caddyfile disables automatic HTTPS.
- Treat the launcher as a privileged service because it has Docker socket access and can control containers on the host.
- Keep VS Code session TTLs short unless there is a specific operational reason not to.
- Replace the bootstrap shared secret sync with a dedicated launcher admin handshake so secret rotation does not require a launcher restart.
- Add refreshable session minting so long-lived IDE tabs can recover after token expiry.
- Add admin settings for allowed extensions and resource limits.
- Add richer container retention policies beyond simple idle shutdown.
- Extend tests to cover Nextcloud-side permission checks and settings persistence.

## Tests

Inside the launcher package:

- Install dependencies with `npm install`.
- Run the launcher test suite with `npm test`.

## App Store release

The Nextcloud Community App Store only distributes the `nextcloud-app/` folder. The launcher service, code-server image, and reverse proxy remain external deployment steps documented in [deployment.md](deployment.md).

To prepare an App Store archive from this repository:

1. Update `nextcloud-app/appinfo/info.xml` and `nextcloud-app/CHANGELOG.md` for the release version.
2. Run `./scripts/package-nextcloud-app.sh`.
3. Upload the generated `dist/nvscode-<version>.tar.gz` archive to a GitHub release or another HTTPS host.
4. Sign the archive with your Nextcloud App Store private key and upload the release in the App Store developer portal.

The detailed release flow, including certificate generation and upload steps, is in [app-store-release.md](app-store-release.md).
