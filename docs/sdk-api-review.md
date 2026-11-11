# Formatter SDK/API review

## Release decision

**Release blocked as of 2026-11-11.** Public Go and npm SDK `0.2.0` exist, but
both lack the formatter extension. Keep the exact `0.1.0` pins in `go.mod`,
`package.json`, and the compatibility-checker command until a supporting pair
is published. Upgrading to `0.2.0` alone does not supply these APIs and raises
the SDK-wide host floor from `0.99.0` to `0.100.0`.

Source-based validation is a separate, unreleased development lane. It does
not establish public SDK, official minimum-host, or release-package compatibility.

## Observation pins

These remote heads were read at the start and rechecked during this review:

| Surface | Exact observation |
| --- | --- |
| [Plugin PR #2](https://github.com/illuwa-soft/kandev-plugin-apprise-templates/pull/2) | `c4d3aa23e79e66b8d412243ae8504b1f55a8efda` |
| [Host PR #5141](https://github.com/kdlbs/kandev/pull/5141) | `801af86298d53e52ad5442d834976bb516d96240` |
| Upstream `main` | `a268e5c409049579576192814b347ffc61b2a4c9`; exact-path API lookup for `pluginsdk/notification_formatter.go` returned 404 |
| Public SDK `0.2.0` source tag | `pluginsdk/v0.2.0`, commit `1529e72ed5b8ccd3bc6fd79498a12d57492ec120` |
| Go SDK module sum | `h1:i4H02Fv8hw0FwqELxd2HUYb8jD/+qaIU0LcU3d7LvNo=` |
| [npm SDK tarball](https://registry.npmjs.org/@kdlbs/plugin-sdk/-/plugin-sdk-0.2.0.tgz) | SHA-1 `76e13fd2ea57608ed782a47ce75d5016356daafd` |
| npm tarball integrity | `sha512-exa9vpGHHnPxuazrUQiro/bvuTBDtLnW2la1xkpb4ZoUhPITjodc48ye5mpuEv6wp1Z43tzPRb4c+k+SvCbARw==` |

`npm view @kdlbs/plugin-sdk version versions dist.tarball dist.integrity --json`
returned stable versions `0.1.0` and `0.2.0` (plus `0.0.0-stage`).
`GOPROXY=https://proxy.golang.org GOWORK=off go list -m -versions github.com/kdlbs/kandev/pluginsdk`
returned `v0.1.0 v0.2.0`. The actual downloaded `0.2.0` Go module and npm tarball
were inspected independently of release labels. Both `sdk-release.json` records declare
`min_kandev_version: 0.100.0`, API versions 1 and 2, and additive changes.

## Actual CI failures

Both runs below belong to plugin head `c4d3aa23e79e66b8d412243ae8504b1f55a8efda`:

| Run and step | Actual log | Classification |
| --- | --- | --- |
| [CI 42576406809](https://github.com/illuwa-soft/kandev-plugin-apprise-templates/actions/runs/42576406809), **Vet** | `server/formatter_plugin.go:23:82: undefined: pluginsdk.NotificationFormatRequest` | Unpublished Go SDK contract; Test was not reached |
| [Build 42576406814](https://github.com/illuwa-soft/kandev-plugin-apprise-templates/actions/runs/42576406814), **Build host binary** | Missing `NotificationFormatRequest`, `NotificationFormatResponse`, `NotificationConfigurationRequest`, `NotificationConfigurationResponse`, and `VerifiedActionContext.NotificationProviderID` | Plugin compilation blocked by SDK contract; package and minimum-host smoke were not reached |

The step named **Build host binary** runs plugin `make build`; it is
not evidence of a Kandev host compilation failure. The earlier SDK checker says
`SDK 0.1.0: compatible (minimum Kandev 0.99.0)` twice, because it checks release
metadata for Go and frontend SDKs. That output does not prove symbol or feature
availability. Local `GOWORK=off make vet` and `make build` reproduced the missing
Go contracts before this review's new frontend gate was added.

No template renderer, snapshot store, or editor regression failure appears in
those remote logs. Successful source-lane tests do not change the remote verdict.

## Contract comparison

All host-source links in this section use the exact reviewed
[host commit](https://github.com/illuwa-soft/kandev/tree/801af86298d53e52ad5442d834976bb516d96240).

| Contract | Host and source SDK | Plugin consumer | Public SDK `0.1.0` / `0.2.0` |
| --- | --- | --- | --- |
| `FormatNotification` | Optional `pluginsdk.NotificationFormatter`; generated client/server RPC and `RemotePlugin` adapter | `server/formatter_plugin.go`, `server/values.go` | Missing interface, DTO aliases, generated RPC, and formatter contexts |
| `InspectNotificationConfiguration` | Optional inspection RPC for immutable owner/provider/key/revision; returns matching revision and 64-character digest | `SnapshotStore.Read` supplies the exact stored snapshot receipt | Missing RPC and request/response types |
| `VerifiedActionContext` | `ActorID` plus `NotificationProviderID` and `NotificationFormatterKey`; protobuf fields 7 and 8 round-trip through Go adapters | Management actions scope storage with verified actor/provider, never identities in `Body` | New provider/key fields missing |
| `ActionInput` | `notificationProviderId` plus `notificationFormatter: { installationId, formatterKey, expectedBindingRevision, mode }` | `ui/editor-controller.js` supplies the envelope to `host.api.invokeAction` | Both formatter-specific selectors missing |
| `NotificationFormatterSlotProps` | Provider identity/events, formatter choice, nullable binding, `selectionChanged`, activation/reload/authoritative-readback/preview callbacks | `ui/bundle.js` and controller consume callbacks and register a shared Save contributor | Formatter types not exported |
| Manifest and packaging | `notification_formatters`, `notification_provider` action scope, installation-bound declared management actions | `manifest.yaml`: API 2, `apprise-text`, contract 1, Apprise only | Runtime/manifest support is a host publication gate; SDK metadata alone is insufficient |

Implementation anchors:

- Go contract and validation: [`pluginsdk/notification_formatter.go`](https://github.com/illuwa-soft/kandev/blob/801af86298d53e52ad5442d834976bb516d96240/pluginsdk/notification_formatter.go).
- Wire DTOs and context: [`pluginsdk/proto/kandev/plugin/v1/plugin.proto`](https://github.com/illuwa-soft/kandev/blob/801af86298d53e52ad5442d834976bb516d96240/pluginsdk/proto/kandev/plugin/v1/plugin.proto), plus `pluginsdk/types.go` for both context conversions.
- Frontend declaration: [`apps/packages/plugin-sdk/src/index.ts`](https://github.com/illuwa-soft/kandev/blob/801af86298d53e52ad5442d834976bb516d96240/apps/packages/plugin-sdk/src/index.ts); host `lib/plugins/types.ts` re-exports it.
- Envelope forwarding: `apps/web/lib/plugins/host-api.ts`; ownership/installation/generation/CAS checks: `apps/backend/internal/plugins/action_handlers.go` and `notification_formatter_management.go`.
- Slot values and shared Save: `apps/web/components/settings/notification-formatters.tsx`; activation fencing/readback: `apps/web/hooks/domains/settings/use-notification-formatter*.ts`.

`FormatNotification` carries contract version, provider/owner/key, immutable
configuration revision, occurrence/event, original title/body,
optional task/inbox/update context, and synthetic preview configuration/sample.
The plugin returns either a complete custom title/body pair or `custom: false`.
The host keeps subscriptions, recipient authority, credentials, claims, and sending.
It must recheck delivery authority after formatting; errors use the original pair.

The source SDK enforces a 128 KiB format request, 4 KiB inspection request, and
512 KiB receive cap on **both** RPCs. Custom title/body limits are 2,048/65,536
UTF-8 bytes; NUL, empty custom values, invalid UTF-8, and title newlines are
rejected. The host shares a one-second formatting budget across fanout;
management has five seconds including body handling. Management JSON has a
128 KiB body limit and 512 KiB response limit. The latest host commit adds
closed-reason management error logging and both RPC receive caps; the source
SDK race suite and focused host formatter tests were run in this review.

## Plugin-owned validation repairs

These are independent of the missing SDK publication:

1. **Frontend contract coverage:** recipe-only typechecking did not exercise
   the formatter API. `make sdk-check` now also compiles
   `tests/formatter-sdk.contract.ts` against the installed SDK. It requires the
   actual exported types, `ActionInput` selectors, and consumed slot callbacks;
   there is no replacement declaration or ignored TypeScript diagnostic.
   The installed `0.1.0` SDK fails this check as expected. An isolated paths map
   to the downloaded `0.2.0` tarball also fails with TS2305/TS2353. The source
   SDK paths map passes, explicitly outside the public lane.
2. **Development target completeness:** `dev-test` used to omit recipe tests
   and recipe typechecking. It now runs the full `make test`, race tests, and
   formatter typecheck. The helper snapshots both source SDK surfaces and
   records their provenance without changing lockfiles or public module pins.
3. **Wrong-product release smoke:** `test:host` and the Linux minimum-host wrapper
   invoked inherited `kandev-plugin-template` routes, greeting, and persisted
   counters. They now invoke the actual packaged formatter workflow; the wrapper
   verifies the official host version and uses its embedded web assets.
   The obsolete starter script remains historical reference, not an active gate.
4. **Diagnostic masking:** a failing screenshot could overwrite the original
   browser exception. DOM/text capture and a bounded screenshot are best-effort;
   the original exception remains the failure. The provider selector uses the
   native `select` in the exact provider row after role-based lookup timed out
   despite that select being present in captured DOM.

The new metadata-plus-contract gate deliberately stays red on unsupported public
SDKs. It neither skips the formatter checks nor silently selects private sources.

## Maintainer requests and publication gates

1. Review and stabilize both optional RPCs, DTOs, generated protobuf service,
   Go aliases/adapters, and provider/key verified action context as one contract.
   Keep non-formatter plugins compatible through `Unimplemented` responses.
2. Review/publish the matching npm declarations: `NotificationFormatterSlotProps`,
   choice/binding/action-context types, `ActionInput` selectors, and callbacks
   including authoritative `readActiveBinding`, optional `selectionChanged`,
   abortable preview, and exact-revision activation.
3. Confirm manifest/action/slot ownership and security semantics, CAS/ABA fencing,
   whole-pair fallback, authority revalidation, response caps, error redaction,
   shared Save ordering, and explicit first activation. Review the two new host
   protections at `801af86298d53e52ad5442d834976bb516d96240` with their tests.
4. Publish a coordinated Go tag and npm package containing those contracts and
   aligned `sdk-release.json` records. State the first supporting released host
   and its SDK-wide minimum; do not reuse a private patched version as that floor.
5. Supply a public, formatter-aware `plugin-pack` revision. The plugin's separate
   `.kandev-tooling-ref` still pins `f0e2e774cfe2df8a0d15e4c21dea7b48580e38fb`.
   Its old manifest parser is not evidence of formatter-package acceptance.
6. After publication, update exact Go/npm/checker pins, regenerate both lockfiles,
   update the manifest minimum from release records, and validate with `GOWORK=off`,
   no source SDK mapping, ordinary build/test, all-platform package verification,
   and the official minimum-host formatter smoke. Publish nothing until approved.

## Verification and artifact provenance

Implementation commit: `8e656fe` (validation repairs only; the packaged Go/UI
product sources remain the PR #2 implementation). A clean-checkout package and
its final browser receipt are the next artifact check. The earlier source-lane
browser receipt passed both viewports; it must not be substituted for that
final package's identity. [The maintainer reply](sdk-api-review-reply.md) is a draft, not a posted
comment. No push, GitHub comment, release, catalog mutation, or deployment is
authorized by these local checks.

Completed checks during this review:

| Check | Result and boundary |
| --- | --- |
| Installed public `0.1.0` Go vet/build before the new frontend gate | Failed on missing formatter DTOs/context, matching remote CI |
| Downloaded public Go `0.2.0` compile probe (`GOWORK=off`, public module proxy) | Failed: missing formatter interface/DTOs/provider/key context |
| Installed public npm `0.1.0` and downloaded npm `0.2.0` formatter contract compilation | Failed: four missing formatter exports and invalid `notificationProviderId` in `ActionInput` |
| `make dev-test KANDEV_FORMATTER_SOURCE=.../apprise-sdk-review` under Node `24.22.2`, Go `1.27.2` | Passed complete plugin Go tests, recipe typecheck and 14 tests, 23 UI/controller/HTTP tests, verifier negatives, five SQLite/backup/capture tests, Go race tests, and source-SDK formatter typecheck |
| Source-lane plugin `make vet check-format` | Passed |
| Source SDK `GOMAXPROCS=4 go test -p 2 -race ./...` | Passed, including latest RPC response-cap regressions |
| Host `internal/plugins` focused formatter tests | Passed, including formatter action failure redaction |
| Host `internal/notifications/service` and `handlers` focused formatter tests | Passed; `httpmw` selection ran no matching tests |
| Host frontend focused tests with Node `24.22.2`, `--project browser-locales --maxWorkers=1` | 3 files, 38 tests passed (`notification-formatters`, `use-notification-formatter`, `host-api`) |
| Host `make build-kandev GOFLAGS='-p=2'` and frontend `pnpm run build` | Passed; frontend build reported chunk-size/dynamic-import warnings |
| `npm audit --audit-level=high` | Zero vulnerabilities |
| Shell/JavaScript syntax and `git diff --check` | Passed |

Initial broad host `make build` timed out after 600 seconds while cross-building
agentctl helpers; the specific `build-kandev` target then passed. Cold plugin race
compilation and a combined host test invocation also exceeded their harness
deadlines; the later listed race/focused invocations completed successfully.
The first host frontend attempt on Node `26.5.0` timed out; selecting `browser`
on Node 24 found no matching files because these suites belong to
`browser-locales`. Only the final 38-test run is counted as passing.

Full core suites and all-platform packaging were not completed. The Linux
official-minimum-host wrapper has syntax validation only in this macOS session;
no supporting released SDK/host has passed it. Operational rollback, authenticated
multi-owner/lifecycle browser coverage, and production runtime continuity remain
outside this source-only validation.
