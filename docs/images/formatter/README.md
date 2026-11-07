# Synthetic editor screenshots

Captured on 2026-11-07 by `scripts/smoke-formatter-host.mjs`, using an isolated
loopback host and synthetic, disabled providers with empty subscriptions.

- Host source: stable `v0.99.1` plus formatter commits, candidate
  `cf8579699e40e38dcb2063d1692c18444c8afbd5`.
- Reported version: `v0.99.1+notification-formatter.1` (private patched build).
- Host binary SHA-256: `4c1efbaa687595ff204889c056c62cb092bee450cf97e3bdaec5c077da5c7283`.
- Plugin archive SHA-256: `2b7869d321d9e776c80392d18d4b0db39e1200f7e73b39c901ee157b1cbf94ac`.
- Desktop viewport: 1440 × 1000. Phone: Playwright Pixel 5 with coarse pointer.
- The test checks viewport fit and the phone Preview button's 44px touch height.

| View | Editor | Controls |
| --- | --- | --- |
| Desktop | [Editor](desktop.png) | [Variables and controls](desktop-controls.png) |
| Phone | [Editor](phone.png) | [Variables and controls](phone-controls.png) |

These images contain no operational templates, credentials, or real receivers.
They demonstrate the development candidate, not an official released host/SDK.
