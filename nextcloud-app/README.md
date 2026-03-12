# nVSCode Nextcloud app

This directory contains the Nextcloud app that is published to the Nextcloud Community App Store as `nvscode`.

The app itself is only one part of the full nVSCode deployment:

- It adds the `Open in nVSCode` action in Nextcloud Files.
- It renders the embedded editor page inside Nextcloud.
- It stores launcher connection settings in Nextcloud admin settings.
- It requests short-lived signed editor sessions from the external launcher service.

The app does not bundle the editor runtime. You must deploy the external launcher service, the `code-server` image, and the same-origin reverse proxy separately.

For full deployment instructions, see the repository-level [README.md](../README.md) and [deployment.md](../deployment.md).