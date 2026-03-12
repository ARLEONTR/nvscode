#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_SOURCE_DIR="$ROOT_DIR/nextcloud-app"
APP_ID="nvscode"
DIST_DIR="$ROOT_DIR/dist"

if [[ ! -f "$APP_SOURCE_DIR/appinfo/info.xml" ]]; then
  echo "Missing app manifest: $APP_SOURCE_DIR/appinfo/info.xml" >&2
  exit 1
fi

version="$(sed -n 's:.*<version>\(.*\)</version>.*:\1:p' "$APP_SOURCE_DIR/appinfo/info.xml" | head -n 1)"

if [[ -z "$version" ]]; then
  echo "Unable to determine app version from info.xml" >&2
  exit 1
fi

mkdir -p "$DIST_DIR"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

package_root="$temp_dir/$APP_ID"
mkdir -p "$package_root"

tar \
  --exclude='.DS_Store' \
  --exclude='.git' \
  --exclude='*.tar.gz' \
  -cf - \
  -C "$APP_SOURCE_DIR" . | tar -xf - -C "$package_root"

archive_path="$DIST_DIR/${APP_ID}-${version}.tar.gz"
tar -czf "$archive_path" -C "$temp_dir" "$APP_ID"

echo "Created $archive_path"