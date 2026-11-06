# Formatter development validation

## Candidate status

This is an unreleased development implementation of Apprise notification
templates. It requires the coordinated Kandev notification formatter extension.
The published Go/npm SDK `0.1.0` and its `0.99.0` host floor do not provide that
extension. A successful private development build is not released-SDK or
unchanged stable-host compatibility evidence.

The implementation derives from template commit
`6dde5f1d550fac87138423c060d610ce85e1f21b`. Historical template results in
[sdk-migration.md](sdk-migration.md) do not validate this formatter product.

## Reproduce development checks

Use Go, Python 3 with SQLite support, Node 24, and the lockfile-installed npm
dependencies. Set `KANDEV_FORMATTER_SOURCE` to an absolute path containing the
reviewed, coordinated Kandev changes, including `pluginsdk` and `apps/backend`.

```sh
npm ci --ignore-scripts
GOMAXPROCS=4 GOFLAGS='-p=2' make dev-test KANDEV_FORMATTER_SOURCE="$KANDEV_FORMATTER_SOURCE"
make check-format
GOMAXPROCS=4 GOWORK="$PWD/.build/development.go.work" go vet -p 2 ./server/... ./cmd/... ./recipes/source-control/server/...
GOMAXPROCS=4 GOFLAGS='-p=2' make dev-package-host KANDEV_FORMATTER_SOURCE="$KANDEV_FORMATTER_SOURCE"
```

The development helper copies the selected SDK into ignored `.build` storage
and records its source revision, dirty state, and tree digest. Normal build and
release targets retain their public dependency checks; they are not a working
release lane for this candidate yet.

## Packaged browser check

Build the selected host binary and web distribution first. Pass absolute paths
to the binary, distribution, and generated host-platform archive:

```sh
node scripts/smoke-formatter-host.mjs "$KANDEV_BINARY" "$KANDEV_WEB_DIST" "$KANDEV_PLUGIN_PACKAGE"
```

The runner starts its own isolated home and loopback backend. It installs the
actual archive and exercises the product editor on desktop and Pixel 5 phone
viewports. It checks all six event previews, whole-pair fallback, preparation
without activation, explicit activation, browser reload, restore-on-Save, and
unchanged disabled providers with empty subscriptions. It does not attach to an
operator instance. Screenshots and digest-bearing receipts remain under ignored
`.build/formatter-browser/`. Owned backend/browser processes and synthetic host
data are cleaned up when the run ends.

Observed on 2026-11-07: development Go race tests, Go vet, formatting, 16 UI tests,
four native snapshot/backup tests, and both packaged browser viewport scenarios
passed. The browser module path check found and corrected imports that did not
follow the host's `/ui/*path` file mapping. Browser checks must be rerun after
subsequent package changes; receipt digests identify only the artifacts
exercised.

## Offline recovery checks

```sh
python3 scripts/snapshot-sqlite.py "$SOURCE_DATABASE" "$NEW_SNAPSHOT"
python3 scripts/verify-backup-set.py "$PRIVATE_MANIFEST" "$TRUSTED_PLUGIN_BINARY"
```

The snapshot helper uses SQLite's backup API, including committed WAL pages. It
builds inside a private same-filesystem staging directory, checks integrity,
syncs, and exclusively installs a `0600` target. It refuses existing targets.
Failure after installation but before the receipt must be reconciled by
inspecting the existing target, not by overwriting it.

The backup verifier accepts schema `1` manifests with `host_version`,
`plugin_version`, `plugin_id`, `installation_id`, `validator_sha256`, and a
`files` object. Each file entry has a relative `path`, `sha256`, and `bytes`;
`host_database` and `plugin_database` are required roles. Additional config and
launcher roles are digest-checked. Paths must remain inside the backup
directory. Referenced host bindings must match installation, owner, provider,
revision, and configuration digest. The explicitly supplied trusted plugin
binary must match its digest pin; it validates the offline store with the same
configuration validator used by live reads, without schema initialization.

This verifier checks byte integrity and reference closure. Manifest version
labels are operator-supplied metadata, not independent proof of artifact
provenance or host downgrade compatibility. A complete capture coordinator must
still hold and recheck the host's bounded configuration capture lease while
collecting the complete set. These helpers alone do not authorize restoration.

## Acceptance gaps

- Pinned four-event legacy renderer oracle and legacy-safe rollback projection.
- Coherent capture coordinator, complete backup/restore drill, and later-edit
  export before rollback.
- Exact latest-stable-plus-patch matrix, unchanged-host rejection, and complete
  plugin lifecycle and ownership browser cases.
- Public SDK publication and a fresh standalone released-dependency lane.
- Final core review, two linked PRs, and the verified operational upgrade.

No production upgrade or public plugin release has been performed by these
development checks.
