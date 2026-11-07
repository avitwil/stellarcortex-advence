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

## P2

### MC-P2-ANDROID-WEBVIEW: Android 9 device with an updated WebView (FR-CLI-02, DL-024)
1. On a real Android 9 phone, update "Android System WebView" (or Chrome) from the store.
2. Install the APK from the CI artifact, open it: the "Connect to your server" screen shows.
3. Pair, sign in, open the Chief of Staff chat and send a message; the streamed reply appears.

### MC-P2-SUBSCRIPTIONS: real subscription round-trips (FR-BOT-04, D-07c)
1. Build the bot-computer image (`podman build -t localhost/advence-bot-computer:latest images/bot-computer`).
2. On your own computer run `claude setup-token`, then in Settings > Models and keys add a "Claude subscription" source and paste the token. Give a Bot that source and chat: a reply arrives; the "personal use only" notice is shown.
3. Add a "ChatGPT subscription" source, press Sign in, open the shown URL, enter the code. When it shows "Signed in", chat with a Bot on that source: a reply arrives.

### MC-P2-PUSH: Android push through ntfy (D-18, FR-PRO-08 base)
1. Run the server with the ntfy sidecar (`ADVENCE_NTFY_BIN`, `ADVENCE_NTFY_BASE_URL`), or set the push server in Settings > Notifications to your ntfy URL.
2. On the phone install the ntfy app (the UnifiedPush distributor) and point it at that server.
3. In the app, Settings > Notifications shows "This device receives notifications". Lock the phone, send a message from the desktop to a Bot: the phone shows a notification within 10 s, and the notification text has no message content.

## P3

### MC-P3-WIN / MC-P3-MAC: Bot computers on a Podman machine (FR-PC-07, P3 exit)
On a fresh Windows 11 PC and a fresh macOS 14+ Mac: install the server, run `advence computer setup`,
create a Bot, open its computer from the chat header, take over and hand back. Then run the
FR-CODE-03 benchmark below on that host. Pass: setup ends with "Bot computers are ready", the
desktop shows within 60 s once the image is built, and the benchmark passes.

### MC-P3-ISOLATION-VM: API not reachable from containers on Windows and macOS (NFR-SEC-08)
In a Bot's computer terminal on each Podman machine host, try
`curl -k https://<host LAN IP>:<server port>/v1/server-info` and the same with
`host.containers.internal`. Pass: no 200 answer. (Linux is covered by CI.)

### MC-P3-BENCH: coding benchmark (FR-CODE-03)
Copy `docs/bench/fr-code-03` into a Bot's `~/workspace`, ask the Bot: "Fix the failing tests
in ~/workspace/fr-code-03 and commit." for each engine. Pass: `npm test` passes and a new
commit exists, with no help.

### MC-P3-LATENCY: smooth desktop (FR-PC-02)
On a LAN client, open the Bot's computer next to the old VM + noVNC; move windows, type in
Chromium, scroll a page. Pass: input latency under 100 ms and at least the same frame rate.

### MC-P3-GPU: NVIDIA GPU passthrough (FR-PC-08)
On a Linux host (and Windows) with an NVIDIA GPU and CDI (`nvidia-ctk cdi generate`), restart
the server. Pass: Settings shows the GPU, and `nvidia-smi` works in the Bot's terminal.

### MC-P3-HOST: host control on each OS (FR-PC-09)
With Host control on for a Bot, ask it to take a screenshot and type into a text editor on
the host, on Linux (X11 and Wayland), Windows and macOS (grant Accessibility and Screen
Recording). Then turn Host control off. Pass: it works when on and the tool is refused when off.

### MC-P3-ANDROID-TAKEOVER: take-over on Android (FR-UI-05)
On the Android app, open a Bot's computer, take over, tap and type, hand back.

## P4

### MC-P4-OBSIDIAN: vault graph in Obsidian (FR-MEM-02)
After a few chats where a Bot saved notes, open Settings → Memory, choose "Use a plain vault for
Obsidian", confirm, and open the folder shown there as a vault in Obsidian. Pass: the graph view
shows the notes linked through their `[[wikilinks]]`, each Bot's `MEMORY.md` lists its notes, and
frontmatter shows as properties. Switch back to encrypted afterwards.

### MC-P4-CLAUDE-CODE: exported skill loads in Claude Code (FR-SKL-05)
Teach a Bot a short process, export the skill from Settings → Skills, and unzip it under
`~/.claude/skills/`. Pass: Claude Code lists the skill and follows it when asked.

### MC-P4-SKILLS-SH: a real skills.sh entry (FR-SKL-01)
Install one public entry from skills.sh and one public GitHub skill folder. Pass: both show the
review with SKILL.md, file list and scan, and become active only after approval.

## P5

### MC-P5-GOOGLE: four Google services with a real test account (FR-GGL-04, FR-GGL-06)
With the Google project in Testing mode and a test user, sign in to the app and press "Connect
Google" on the card shown after login. Pass: one consent screen lists Gmail, Calendar, Drive and
Contacts; Settings → Google shows all four as connected; a Bot can search and read mail, create a
draft and send it to yourself, list and create a calendar event, find and read a Drive file,
upload a file, and look up a contact.

### MC-P5-GOOGLE-EXPIRY: the real 7-day limit (FR-GGL-05)
Keep the connection from MC-P5-GOOGLE for 7 days. Pass: on day 6 a notification and the reminder
card appear; after day 7 the card and Settings show "reconnect" and Google tools say so; one tap
on "Reconnect" restores all four services.

### MC-P5-GOOGLE-ANDROID: consent on a phone (FR-GGL-04)
On Android, press "Connect Google". Pass: Google's own consent sheet appears once and Settings →
Google then shows the four services.

### MC-P5-MCP-SIGNIN: sign-in to a real protected MCP server (FR-MCP-03)
Add a public MCP server that needs OAuth and press "Sign in" on the desktop app, then in the
browser UI. Pass: the browser opens the provider's page; the desktop finishes on its own, the
browser UI finishes after pasting the address; tools then list and a Bot can call one.

### MC-P5-CLAUDE-CODE: Claude Code reaches the Bots (FR-MCP-04)
In Settings → MCP, create an access token and download the certificate. On the owner's PC, add
the endpoint to Claude Code as an HTTP MCP server with the header `Authorization: Bearer <token>`
and `NODE_EXTRA_CA_CERTS` set to the certificate. Pass: Claude Code lists the Bots and routines,
sends a message to a Bot and gets its reply, and reads a Library file.

## Results
| Check | Date | Result | Notes |
|---|---|---|---|
