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

## P1

### MC-P1-ANDROID: pairing, Google login and chat on Android (P1 exit, FR-CLI-02/03, FR-GGL-02)
Prerequisite: a running server (`advence serve`) on the LAN, Google setup done (MC-S4-GOOGLE),
and in the Google Cloud project an **Android** OAuth client for package
`com.stellarcortex.advence` with the SHA-1 of the key that signed the APK (the setup wizard
shows both; for the CI debug APK use the debug key SHA-1 printed by
`keytool -list -v -keystore ~/.android/debug.keystore -storepass android`).
1. Install the APK from the CI `android-apk` artifact on an Android 9+ phone.
2. On the server console run `advence pair`; a QR and a link are shown.
3. In the app tap **Scan QR**, allow the camera, scan the QR.
4. The app shows a 6-digit code. Type the same code on the server console (or approve
   in desktop Settings > Devices). Expected: the codes match and the app moves on.
5. Tap **Sign in with Google** and pick your account. Expected: you reach the main screen.
6. Expected: the chat area shows "connected" and the ping round-trip succeeds.
7. Repeat steps 2-4 with a **wrong** server (another server's link with the first server's
   address). Expected: the app refuses with a key-mismatch error.

### MC-P1-WIN / MC-P1-MAC: desktop installers (FR-CLI-01, P1 exit)
1. In GitHub > Actions run the `installers` workflow on the PR branch (Run workflow).
2. Download `desktop-windows-2025` (.exe) and `desktop-macos-15` (.dmg).
3. Windows 11: run the installer (SmartScreen: More info > Run anyway, since it is
   unsigned per C-04). macOS 14+: open the DMG, drag to Applications, first launch with
   right-click > Open (ad-hoc signed).
4. Paste the pairing link from `advence pair`, type the code on the server, sign in with
   Google in the system browser. Expected: the app shows the main screen and the chat
   ping round-trip works.

### MC-P1-KEYSTORE: master key in the OS keystore (NFR-SEC-04)
1. Run the server once on Windows 11, macOS 14+ and a Linux desktop with a keyring.
2. Expected: `advence serve` logs `master key created` with `"method":"os-keystore"` and
   does not ask for a passphrase; `master.json` in the data folder names the keystore
   (`windows-dpapi`, `macos-keychain` or `linux-secret-service`). After a restart it logs
   `master key unlocked`, again without a passphrase.

### MC-P1-WIZARD: setup wizard timing (FR-GGL-01)
1. Give a non-technical tester a fresh server and the desktop app.
2. Expected: they complete the Google setup wizard (project, consent screen, Web and
   Android clients, paste ID and secret) in under 15 minutes without help.

## Results
| Check | Date | Result | Notes |
|---|---|---|---|
