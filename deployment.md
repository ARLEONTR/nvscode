# Deploying nVSCode Into An Existing Nextcloud

This guide explains how to add nVSCode to an already-running Nextcloud deployment without replacing your current Nextcloud stack.

nVSCode has three moving parts:

- the Nextcloud app in [nextcloud-app](nextcloud-app)
- the launcher service in [launcher](launcher)
- a code-server image, typically built from [docker/code-server-base](docker/code-server-base)

The important design constraint is same-origin proxying. Users open nVSCode inside Nextcloud, but the actual editor traffic under `/apps/nvscode/proxy/...` must be reverse-proxied to the launcher on the same public origin as Nextcloud.

## What Must Be True

Before you deploy it into an existing environment, make sure these assumptions fit your setup:

- Your Nextcloud version is 29 or 30. The app manifest currently declares support for that range.
- You can install a custom app into Nextcloud as `custom_apps/nvscode`.
- You control the reverse proxy in front of Nextcloud and can route `/apps/nvscode/proxy/*` to the nVSCode launcher.
- The launcher host can access the real Nextcloud data directory on disk.
- The launcher host can create Docker containers and currently expects Docker socket access.
- Your Nextcloud primary storage is the standard local filesystem layout under the data directory.

If your Nextcloud uses primary object storage, remote external storage, or a storage layout that does not expose user files as `${NEXTCLOUD_DATA_DIR}/${userId}/files`, nVSCode will not mount workspaces correctly without further changes.

## Deployment Model

For an existing installation, do not deploy the demo `nextcloud`, `db`, or `caddy` services from [docker-compose.yml](docker-compose.yml). Reuse your existing Nextcloud and only deploy these pieces:

- the nVSCode Nextcloud app
- the nVSCode launcher
- the nVSCode code-server image
- a reverse-proxy rule for `/apps/nvscode/proxy/`

## Step 1: Build And Publish The code-server Image

Build the image from this repository:

```bash
docker build -t registry.example.com/nvscode-code-server:latest ./docker/code-server-base
docker push registry.example.com/nvscode-code-server:latest
```

That image includes:

- code-server
- Typst
- Pandoc 3.9
- default extension bootstrap support used by the launcher

If you do not want to publish it to a registry, you can keep it local on the launcher host and reference the local image tag there.

## Step 2: Install The Nextcloud App

Copy the app into your existing Nextcloud custom apps directory as `nvscode`:

```bash
rsync -a ./nextcloud-app/ /var/www/nextcloud/custom_apps/nvscode/
```

Then enable it:

```bash
php occ app:enable nvscode
```

If your Nextcloud runs in Docker:

```bash
docker exec -u www-data nextcloud-app php occ app:enable nvscode
```

The app adds:

- the `Open in nVSCode` file action in Nextcloud Files
- the `/apps/nvscode/editor` page
- the admin settings page for nVSCode

## Step 3: Deploy The Launcher

The launcher is the service that:

- mints signed session URLs
- creates one code-server container per Nextcloud user
- mounts only that user's files into `/workspace`
- persists each user's editor state

You can run it with plain Docker or Compose. The simplest production-shaped approach is a small Compose file dedicated to the launcher.

Example:

```yaml
services:
  nvscode-launcher:
    image: registry.example.com/nvscode-launcher:latest
    build:
      context: /opt/bottomroot/launcher
    environment:
      PORT: 3000
      INTERNAL_SHARED_SECRET: change-this-to-a-long-random-value
      SESSION_SIGNING_SECRET: use-a-second-long-random-value
      NEXTCLOUD_DATA_HOST_PATH: /srv/nextcloud/data
      LAUNCHER_STATE_HOST_PATH: /srv/nvscode/state
      DOCKER_NETWORK_NAME: nextcloud_default
      CODE_SERVER_IMAGE: registry.example.com/nvscode-code-server:latest
      CODE_SERVER_RUN_AS: 33:33
      CODE_SERVER_CONTAINER_PREFIX: nvscode-code-server
      CODE_SERVER_DEFAULT_EXTENSIONS: myriad-dreamin.tinymist,mathematic.vscode-pdf
      DEFAULT_SESSION_TTL_SECONDS: 3600
      DEFAULT_IDLE_TIMEOUT_SECONDS: 3600
      CLEANUP_INTERVAL_SECONDS: 300
      FILE_SCAN_INTERVAL_SECONDS: 15
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /srv/nvscode/state:/srv/nvscode/state
```

Notes:

- `NEXTCLOUD_DATA_HOST_PATH` must be the real host path of the existing Nextcloud data directory.
- `LAUNCHER_STATE_HOST_PATH` is separate and stores code-server user state, extensions, and settings.
- `DOCKER_NETWORK_NAME` must be a Docker network that both the launcher and the per-user code-server containers can use.
- `CODE_SERVER_IMAGE` should be the image you built in step 1.
- the launcher probes `${NEXTCLOUD_DATA_HOST_PATH}/${userId}/files` and starts each code-server container with that directory's UID/GID
- `CODE_SERVER_RUN_AS` is the fallback if that ownership probe is unavailable or returns unusable output. A common Dockerized Nextcloud value is `33:33` for `www-data`.

If your existing Nextcloud runs in Docker, the easiest option is to attach the launcher to the same Docker network and point the app at the launcher's internal DNS name.

If your existing Nextcloud is not containerized, the launcher can still run in Docker, but the launcher host must still be able to read the same Nextcloud data directory path that Nextcloud uses.

## Step 4: Configure nVSCode Inside Nextcloud

nVSCode needs these values on the Nextcloud side:

- `launcher_url`: internal URL that Nextcloud server-side code uses to call the launcher
- `shared_secret`: must match `INTERNAL_SHARED_SECRET` on the launcher
- `session_ttl_seconds`
- `idle_timeout_seconds`
- `code_server_image`

You can set them either in the nVSCode admin UI or with `occ`.

Example with `occ`:

```bash
php occ config:app:set nvscode launcher_url --value="http://nvscode-launcher:3000"
php occ config:app:set nvscode shared_secret --value="change-this-to-a-long-random-value"
php occ config:app:set nvscode session_ttl_seconds --value="3600"
php occ config:app:set nvscode idle_timeout_seconds --value="3600"
php occ config:app:set nvscode code_server_image --value="registry.example.com/nvscode-code-server:latest"
```

Important:

- `launcher_url` is not the public browser URL.
- It is the internal URL Nextcloud uses to reach `POST /internal/sessions` on the launcher.
- The public browser-facing path is handled by your reverse proxy in the next step.

## Step 5: Add Same-Origin Reverse Proxying

This is the part that makes nVSCode feel native inside Nextcloud.

Users load Nextcloud normally, and the iframe URL points to:

```text
/apps/nvscode/proxy/session/<signed-token>/...
```

Your public reverse proxy must forward `/apps/nvscode/proxy/*` to the launcher and strip the `/apps/nvscode/proxy` prefix before forwarding.

### Nginx Example

```nginx
location ^~ /apps/nvscode/proxy/ {
  rewrite ^/apps/nvscode/proxy/(.*)$ /$1 break;

    proxy_pass http://nvscode-launcher:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 3600;
    proxy_send_timeout 3600;
}
```

### Caddy Example

```caddy
handle_path /apps/nvscode/proxy/* {
    reverse_proxy nvscode-launcher:3000
}

handle {
    reverse_proxy nextcloud:80
}
```

Requirements:

- keep this on the same public origin as Nextcloud
- support WebSocket upgrades
- do not expose `/internal/sessions` publicly
- use HTTPS in real deployments

## Step 6: Make Sure The Launcher Can Mount Existing Nextcloud Data

nVSCode currently mounts workspaces directly from the Nextcloud data directory.

For user `alice`, the launcher expects this host path to exist:

```text
${NEXTCLOUD_DATA_HOST_PATH}/alice/files
```

That directory becomes `/workspace` inside Alice's code-server container.

This means:

- the launcher host must see the same filesystem tree
- file permissions must allow the code-server container to read and write those files
- the launcher must be able to inspect `${NEXTCLOUD_DATA_HOST_PATH}/${userId}/files` so it can derive the correct UID/GID per user
- keep `CODE_SERVER_RUN_AS` set to a sensible fallback such as `33:33`

## Step 7: Validate The Integration

After deployment:

1. Open Nextcloud Files.
2. Pick a file and click `Open in VS Code`.
3. Confirm that Nextcloud loads an iframe under `/apps/nvscode/proxy/session/...`.
4. Confirm the launcher creates a per-user code-server container.
5. Confirm the workspace root corresponds to the user's real Nextcloud files.
6. Confirm Typst preview works and PDF files open in the PDF viewer.

Useful checks:

```bash
curl -I https://cloud.example.com/apps/nvscode/proxy/session/test
docker ps --format '{{.Names}}'
docker logs nvscode-launcher
```

## Existing Deployment Patterns

### Existing Dockerized Nextcloud

This is the easiest case.

- attach the launcher to the same Docker network as Nextcloud
- set `launcher_url` to the launcher's internal service name and port
- mount the same host Nextcloud data path into the launcher environment
- add the reverse-proxy rule on your existing frontend

### Existing Bare-Metal Nextcloud

This can still work, but only if the launcher host can access the actual Nextcloud data directory path.

The typical shape is:

- existing bare-metal Nextcloud stays as-is
- nVSCode launcher runs in Docker on the same host
- reverse proxy forwards `/apps/nvscode/proxy/*` to the launcher container
- the Nextcloud app is copied into the existing `custom_apps` directory

## What This Guide Does Not Solve

These are current design limits, not deployment mistakes:

- the launcher still requires Docker socket access
- the launcher assumes filesystem-based Nextcloud primary storage
- long-lived editor tabs do not yet auto-refresh expired nVSCode session URLs
- secret rotation is still manual

## Recommended Production Posture

At minimum:

- keep the launcher reachable only from Nextcloud and the same-origin reverse proxy
- use strong random values for `shared_secret` and `SESSION_SIGNING_SECRET`
- keep the session TTL short
- put the public Nextcloud origin behind HTTPS
- monitor the launcher because it is a privileged service in the current design

If you want a smaller blast radius later, the next architectural step is replacing direct Docker socket access with a narrower worker or API boundary.