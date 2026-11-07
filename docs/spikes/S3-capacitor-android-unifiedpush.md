# Spike S3: Capacitor Android shell + UnifiedPush/ntfy

Phase: P0. Requirement refs: D-05, D-18, FR-CLI-02, FR-PRO-08.

## What ran here
- The React UI builds with Vite and is loaded by the Capacitor shell config
  (`apps/android`). The web bundle part was verified in P1 (see `docs/phases/P1.md`).
- The Android SDK host (`dl.google.com`) is not reachable from this sandbox, so the APK
  is built in CI (`.github/workflows/ci.yml`, job `android`) on GitHub's runners, which
  have the SDK preinstalled. Free for this private repo within the included minutes.

## Not runnable here
- APK install and run on a real Android 9+ device and an emulator (no KVM here).
- UnifiedPush delivery over 24 h through a self-hosted ntfy.
Both are manual checks MC-S3-APK and MC-S3-PUSH in `docs/manual-checks.md`.

## Design
- Push path (D-18): server -> ntfy (sidecar, Apache-2.0, downloaded from the official
  release by the installer, never vendored) -> ntfy Android app (the UnifiedPush
  distributor) -> our app's UnifiedPush receiver. The payload is only
  `{"t":"wake","id":"<opaque id>"}`. The app then fetches content over the pinned
  connection.
- FCM fallback exists only as an off-by-default switch; nothing in v1 needs it.

## Fallback
If UnifiedPush delivery is unreliable on a device (aggressive battery optimizers), the
app asks the user to exempt the ntfy app from battery optimization (documented). FCM
stays off by default.
