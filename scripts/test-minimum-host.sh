#!/bin/sh
# Linux amd64 released-host check. The formatter runner owns its disposable HOME.
set -eu
repo_dir=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
cd "$repo_dir"
[ "$(go env GOOS)-$(go env GOARCH)" = linux-amd64 ] || {
  echo 'minimum-host runner requires Linux amd64' >&2
  exit 1
}
package_path="$repo_dir/$(make --no-print-directory -s package-file)"
[ -f "$package_path" ] || { echo "Package not found: $package_path; run make verify-package first" >&2; exit 1; }
smoke_dir=$(mktemp -d)
trap 'rm -rf "$smoke_dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
minimum=$(node -p 'require("@kdlbs/plugin-sdk/sdk-release.json").min_kandev_version')
asset=kandev-linux-x64.tar.gz
release_url="https://github.com/kdlbs/kandev/releases/download/v$minimum"
curl --fail --silent --show-error --location "$release_url/$asset" -o "$smoke_dir/$asset"
curl --fail --silent --show-error --location "$release_url/$asset.sha256" -o "$smoke_dir/$asset.sha256"
(cd "$smoke_dir" && sha256sum -c "$asset.sha256" && tar -xzf "$asset")
# '-' selects the release's embedded web assets. No source-built web distribution.
KANDEV_FORMATTER_EXPECT_HOST_VERSION="v$minimum" \
  npm run test:host -- "$smoke_dir/kandev/bin/kandev" - "$package_path"
