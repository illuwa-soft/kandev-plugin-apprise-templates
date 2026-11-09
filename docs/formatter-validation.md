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
five native snapshot/backup tests, and both packaged browser viewport scenarios
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
When an installation record is present, validation also checks its actual
plugin/installation/version/API identity, platform executable reference, and
formatter key/type/contract against host bindings. Original private runtime
paths remain in `source_path` metadata for internal reference checks; the
validator does not execute or require those original paths during recovery.
Database-only inspection returns `installation_checked: false` and cannot
complete a full capture.

The capture coordinator accepts a private plan and a new absolute output path:

```sh
python3 scripts/capture-backup-set.py "$PRIVATE_PLAN" "$NEW_BACKUP_DIRECTORY"
```

The plan names an explicit loopback `api_base_url`, host/plugin identity,
absolute `host_database` and `plugin_database`, and pinned file roles
`host_binary`, `plugin_binary`, `launcher`, `configuration`, `plugin_record`,
and `plugin_package`. Every file role supplies `path` and `sha256`. Optional
authentication comes from `KANDEV_CAPTURE_TOKEN`, never command arguments or
the plan. The coordinator acquires one five-minute host configuration lease,
captures native DB snapshots and pinned files, validates runtime configuration
and binding closure, rechecks the lease, and releases it before installing the
final manifest. It syncs both the output directory and its parent before
reporting success. Acquisition/release mutations are not automatically retried.
Verification or lease failure leaves pending artifacts. A finalization I/O
failure has an uncertain outcome: preserve the output and inspect any manifest
before retrying, rather than overwriting an existing directory.

The live smoke additionally passed a four-template offline-export-to-live-import
pipeline, explicit activation, unchanged subscriptions, and a three-binding
same-candidate restore. It exports later edits before replacing fixture DBs and
keeps all six settings alongside an explicit four-event `legacy-v1` projection.
This is a disposable same-candidate drill, not an operational downgrade tool.

This verifier checks byte integrity and reference closure. Manifest version
labels are operator-supplied metadata, not independent proof of artifact
provenance or host downgrade compatibility. These helpers alone do not authorize
restoration or replacement of a production service.

## Acceptance gaps

- Operational rollback to a supported older host, including schema compatibility.
- Complete plugin lifecycle, authenticated multi-owner browser cases, and
  operational runtime/session continuity checks.
- Public SDK publication and a fresh standalone released-dependency lane.
- Final core review, two linked PRs, and the verified operational upgrade.

The pinned legacy oracle now covers 38 render and six URL cases; see
[the oracle provenance](../testdata/legacy-migration/README.md). The
`templates.export` action accepts `target: "legacy-v1"` to return `current`
(all six supported events), `legacy` (only the original four), and
`retained_additional_events`. It rejects invalid configuration rather than
silently discarding newer settings. Each document retains owner/provider/source
revision provenance; the projection has its own configuration digest.

## Stable source compatibility

The unmodified `v0.99.1` source (`813a741b21108ea8ed10ab58954d85c2e5205999`)
rejects the formatter manifest with HTTP 400 before activation. The corresponding
private patched candidate (`cf8579699e40e38dcb2063d1692c18444c8afbd5`) reports
`v0.99.1+notification-formatter.1` and passed the same desktop/phone, six-event,
four-template migration, and three-binding recovery drill as the main-based
development candidate. It uses the normal `fts5` backend build target. SDK
protobuf regeneration is clean, the complete stable-source SDK race suite and
formatter-focused backend tests pass, and frontend typecheck/build pass.

This is locally built stable-source compatibility evidence, not verification of
an official release archive. Public SDK `0.1.0` still does not supply this
extension. See [screenshot provenance](images/formatter/README.md).

```sh
# Optional evidence lane and synthetic screenshots tracked for review.
KANDEV_FORMATTER_EVIDENCE_LANE=stable-patched KANDEV_FORMATTER_CAPTURE_DOCS=1 \
  node scripts/smoke-formatter-host.mjs "$KANDEV_BINARY" "$KANDEV_WEB_DIST" "$KANDEV_PLUGIN_PACKAGE"
# Read-only compatibility assertion on an isolated unmodified stable host.
node scripts/smoke-formatter-host.mjs "$UNMODIFIED_KANDEV_BINARY" "$KANDEV_WEB_DIST" "$KANDEV_PLUGIN_PACKAGE" reject
```

The broader core plugin suite has a non-loopback HTTPS executor fixture timeout
also reproduced on unchanged upstream. A full frontend suite run exceeded 600
seconds without a final result. Focused formatter tests, whole frontend lint,
typecheck, and changed-package Go lint pass; those two broader results must not
be described as green.

No production upgrade or public plugin release has been performed by these
development checks.

## Editor review follow-up (2026-11-09)

Candidate loading errors no longer register a page-wide Save veto. The editor's
Save rejects its own unavailable state, leaving the draft dirty and navigation
guarded, while the host coordinator continues saving independent settings.

Delayed snapshot loads replay only newer field edits over the saved configuration;
they preserve untouched templates and the Reset baseline. Retry retains edits made
after failed loading. A successful import supersedes an older snapshot response
without discarding the event/variable catalog. These sequences have controller
regressions and a mounted editor contributor-contract check.

The explicit private-source lane passed the complete `make test` target: Go server,
exporter and recipe packages, recipe typecheck and 14 recipe tests, UI/controller
and HTTP polling tests (23), package/release verifier negatives, and five native
snapshot/capture/backup tests. The public SDK pins are unchanged and still do not
implement the formatter extension.

The host-platform package also passed managed desktop and Pixel 5 workflows,
six-event previews, default fallback, prepare/explicit activation, reload/restore,
four-template migration and exact three-binding recovery on the rebuilt local
host. The receipt is retained under ignored `.build/formatter-browser/`; it
identifies the precise development host and package bytes, not a public release.

Final follow-up package SHA-256:
`2fd255e41caf1d5d91196d40c03a6a9c7f609e62e3a800a2c404f4f9a5853574`.
Rebuilt development host SHA-256:
`6d2038b6017273bb989c31b3229b7b1f7a08ada8df8b26c34214e641f4284055`.
The final two-axis review found no remaining findings in the requested fix scope.
