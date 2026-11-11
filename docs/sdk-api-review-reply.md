# SDK/API review reply draft

Draft only. This has not been posted.

---

Thanks for reviewing the formatter boundary. I rechecked the actual public SDK
artifacts and both PR heads on 2026-11-11:

- Host PR #5141: `801af86298d53e52ad5442d834976bb516d96240`.
- Plugin PR #2: `c4d3aa23e79e66b8d412243ae8504b1f55a8efda` at review start.
- Public Go/npm SDK `0.2.0` is available, with a `0.100.0` minimum host, but it
  still does not include the formatter extension. The plugin remains pinned to
  `0.1.0` and is **not release-ready**.

The failing plugin checks have a concrete dependency cause: CI run 42576406809
stops at Vet on `undefined: pluginsdk.NotificationFormatRequest`; Build run
42576406814 stops compiling the plugin on the formatter request/response types
and `VerifiedActionContext.NotificationProviderID`. Neither run reaches package
or minimum-host smoke validation. The generic SDK metadata checker passing is
not evidence that these APIs are published. Separate compile probes against
both downloaded `0.2.0` SDKs confirm the same contract gap.

I also found and repaired plugin-owned validation gaps locally: formatter API
typechecking was missing, the development target omitted the recipe checks,
and the minimum-host smoke still tested the original starter plugin. The public
lane now explicitly checks the formatter TypeScript contract; the smoke path
exercises the packaged Apprise editor rather than starter routes.

Please review/confirm the following before I select a public SDK pin:

1. The optional `FormatNotification` and `InspectNotificationConfiguration` RPCs,
   DTOs, generated service/adapters, and verified provider/formatter context.
2. `NotificationFormatterSlotProps`, its choice/binding/action-context types,
   the `ActionInput` selectors, authoritative binding readback, abortable preview,
   shared Save integration, and explicit exact-revision first activation.
3. Provider/installation ownership, CAS/ABA fencing, whole-pair fallback,
   post-format delivery-authority checks, bounded requests/responses, and closed
   error logging. The latest host commit's two 512 KiB RPC caps and log-redaction
   regression are included in the source-lane review.
4. Coordinated public Go/npm SDK publication with matching release records,
   the first supported host release, and a formatter-aware public packaging-tool
   revision. SDK `0.2.0` alone is not that release.

The refreshed source-only checks include the SDK race suite, focused host
formatter backend tests, 38 host frontend tests, plugin tests, and a packaged
desktop/Pixel 5 drill covering all six event previews, fallback, prepare and
explicit activation, reload/restore, four-template migration, and exact
three-binding recovery. These use the unreleased source SDK and a locally
built host; they do **not** demonstrate public SDK or official release compatibility.
The pinned identities, artifact digests, results, and remaining gates are in
`docs/sdk-api-review.md`.

Once the supporting SDKs and host are published, I can update the exact pins
and rerun the clean public-dependency build/test/all-platform-package and
minimum-host formatter workflow. No release or operational deployment has been
performed as part of this review.
