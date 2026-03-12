# Publishing nVSCode to the Nextcloud Community App Store

This repository contains multiple deployment components, but the App Store release archive must contain only the Nextcloud app folder with a single top-level directory named `nvscode`.

## What gets published

The App Store package is built from `nextcloud-app/` only. The launcher, Docker image, and reverse proxy configuration are not distributed through the Nextcloud App Store.

## One-time setup

1. Create a certificate request:

   ```bash
   mkdir -p ~/.nextcloud/certificates
   openssl req -nodes -newkey rsa:4096 \
     -keyout ~/.nextcloud/certificates/nvscode.key \
     -out ~/.nextcloud/certificates/nvscode.csr \
     -subj "/CN=nvscode"
   ```

2. Submit the CSR in a pull request to the Nextcloud certificate request repository:

   `https://github.com/nextcloud/app-certificate-requests`

3. After approval, store the signed certificate as `~/.nextcloud/certificates/nvscode.crt`.

4. Register the app in the App Store developer portal with:

   ```bash
   echo -n "nvscode" | \
     openssl dgst -sha512 -sign ~/.nextcloud/certificates/nvscode.key | \
     openssl base64
   ```

   Use the resulting base64 signature together with the contents of `nvscode.crt` at:

   `https://apps.nextcloud.com/developer/apps/new`

## Per-release workflow

1. Update `nextcloud-app/appinfo/info.xml` with the release version.
2. Add the matching release entry to `nextcloud-app/CHANGELOG.md`.
3. Build the release archive:

   ```bash
   ./scripts/package-nextcloud-app.sh
   ```

   A GitHub Actions workflow in `.github/workflows/release-nextcloud-app.yml` also builds and uploads the archive automatically whenever you push a `v*` tag.

4. Host the generated archive from `dist/` on an HTTPS URL, usually as a GitHub release asset.
5. Sign the archive:

   ```bash
   openssl dgst -sha512 \
     -sign ~/.nextcloud/certificates/nvscode.key \
     dist/nvscode-<version>.tar.gz | openssl base64
   ```

6. Upload the release at:

   `https://apps.nextcloud.com/developer/apps/releases/new`

## Notes

- The archive must contain exactly one top-level folder named `nvscode`.
- `nextcloud-app/appinfo/info.xml` must remain valid against the App Store schema.
- The App Store package should not include `.git`, `.DS_Store`, secrets, or local build output.
- The Community App Store distributes the app connector only. Administrators still need the external launcher service described in [deployment.md](deployment.md).