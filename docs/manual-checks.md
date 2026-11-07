# Manual checks on real hardware

These acceptance criteria cannot run in the build environment (Linux cloud container, no
KVM, no Windows/macOS/Android device, no NVIDIA GPU, no real Google account). They are
**not** marked as passed until the owner runs them. Each item lists exact steps and the
expected result. Record the result in the table at the end.

## P0

### MC-PC-02: desktop latency vs the old VM (FR-PC-02, spike S1)
1. On the LAN, open the old StellarCortex VM desktop in noVNC on a laptop, and a bot
   computer desktop in StellarCortex Advence on the same laptop.
2. In each, open a terminal, hold a key for 5 s, then drag a window in circles for 10 s.
3. Expected: Advence feels at least as smooth; typed characters appear with no visible
   lag (target < 100 ms). Optional: record both screens at 60 fps and count frames from
   key press to glyph.

### MC-S2-WIN: Podman machine on Windows 11 (spike S2)
1. Install Podman for Windows from https://podman.io (free), choose the WSL2 provider.
2. `podman machine init --cpus 4 --memory 8192` then `podman machine start`.
3. In the repo: `podman build -t localhost/advence-bot-computer:dev images/bot-computer`.
4. `"spikepw1" | podman secret create vncpw -`
5. `podman run -d --name bc1 -p 127.0.0.1:16080:6080 --secret vncpw,target=/run/secrets/vnc_password localhost/advence-bot-computer:dev`
6. Open `http://127.0.0.1:16080/vnc.html`, password `spikepw1`.
7. In the desktop terminal: `chromium --no-first-run chrome://sandbox`.
8. Expected: the Xfce desktop shows; the sandbox page says "You are adequately sandboxed".
9. With an NVIDIA GPU: `podman run --rm --device nvidia.com/gpu=all localhost/advence-bot-computer:dev nvidia-smi` lists the GPU (FR-PC-08).

### MC-S2-MAC: Podman machine on macOS 14+ (spike S2)
Same as MC-S2-WIN steps 2-8 on macOS (Apple silicon and Intel). GPU is not expected.

### MC-S3-APK: Android shell on device and emulator (spike S3, FR-CLI-02)
1. Download the `android-apk` artifact from the latest CI run of the PR.
2. Install on an Android 9+ phone (`adb install app-release.apk`) and on an emulator
   (x86_64 image, API 28 and API 35).
3. Expected: the app opens to the server-connection screen in both.

### MC-S3-PUSH: UnifiedPush delivery over 24 h (spike S3, D-18)
1. Install the ntfy Android app (F-Droid or GitHub release) on the phone.
2. Pair the app with a running server (see MC-P1-PAIR), enable notifications.
3. Leave the phone idle on battery for 24 h; the server sends a test push every hour
   (`advence admin push-test --hourly 24`).
4. Expected: 24 of 24 notifications arrive, each within 10 s.

### MC-S4-GOOGLE: real Google login + Gmail (spike S4)
1. Complete the setup wizard (FR-GGL-01) with your own free Google Cloud project.
2. Sign in on the desktop app with your Google account.
3. Expected: login succeeds; the account becomes owner; Settings > Google shows Gmail,
   Calendar, Drive and Contacts connected (after P5).

## Results
| Check | Date | Result | Notes |
|---|---|---|---|
