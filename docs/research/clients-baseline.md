# StellarCortex-advence: clients, server portability, push (research brief)

Date: 2026-11-07. Researcher: research agent. Read-only: nothing under D:\stellarcortex was modified.
Legend: [S] = sourced from a fetched primary or a cited page. [I] = my inference. [U] = not verified here (general knowledge or unconfirmed search snippet).

## 1. Baseline: current StellarCortex (v0.1.3)

| Area | What the repo shows | Source |
|---|---|---|
| Server stack | Node.js 22.16+ ESM app, `node:http`, `ws` for display and browser gateways, JSON state file, vanilla-JS web UI in `public/` (no framework, vendored noVNC). Port 4317, loopback by default. | D:\stellarcortex\package.json, README.md, public/ listing [S] |
| Bot runtime | Engine orchestrates providers: Codex CLI (`@openai/codex` 0.164.0), Claude Code (`@anthropic-ai/claude-code` 2.1.310, optional), HTTP API and local-model adapters. Kanban, routines, webhooks, team hand-offs. | package.json, src/engine.mjs, src/http-provider.mjs [S] |
| Model access | Subscription sign-ins via provider CLIs run as the server OS user; API keys encrypted in the data folder; local servers (Ollama, llama.cpp, LM Studio, vLLM). | README.md "Accounts and models" [S] |
| Virtual computer | QEMU/KVM Ubuntu guest, libvirt broker, per-bot unprivileged users, Xfce/TigerVNC desktops. Needs `/dev/kvm`, 10 GiB RAM, 90 GiB disk. | docs/COMPUTER.md, docs/SHARED-DESKTOP.md, README "Check the host" [S] |
| Host control | Shell and screen on the host; X11 only (`xdotool`). `hostCapability()` returns "unsupported" for any non-Linux platform. | docs/COMPUTER.md, src/computer-mode.mjs [S] |
| Auth and pairing | 256-bit installation access key; HttpOnly + SameSite=Strict cookies; custom header on mutating calls; Host/Origin checks. Remote access via SSH tunnel or Tailscale HTTPS socket. | docs/DEPLOYMENT.md [S] |
| Desktop client | Electron 45.2.3, electron-builder 26.18.0, NSIS target only, fuses set (asar integrity, runAsNode off). Connects via `ssh.exe` tunnel to 127.0.0.1:4317, pins SSH host fingerprint, stores workspace key with `safeStorage`. Installer not code-signed yet. | desktop/package.json, desktop/src/tunnel.js, keys.js, main.js; docs/WINDOWS-APP.md [S] |
| Updater | GitHub release tarball + `release.json` (SHA-256, size) + Ed25519 signature; keys pinned in install; supervisor stages, backs up, rolls back. Root-owned "kit" step via systemd unit. | docs/UPDATES.md [S] |
| Linux-only parts | `install.sh` (uname check, apt, systemd user unit, `stcortex` command, nftables/ufw handling), KVM/libvirt broker, X11 host screen, Docker image (server-only, "not tested end to end"). | install.sh, docs/DEPLOYMENT.md, README [S] |

**Reusable as-is:** the whole web UI in `public/` (single source for every client), engine/store/provider layers, signed-release and rollback design, the desktop SSH-tunnel and key-pinning logic (`desktop/src/*.js`), the security-boundary docs.
**Not reusable on mobile:** `ssh.exe` tunnel (Windows tool path), `safeStorage` (Electron API), the Electron window shell.

## 2. Clients: shell options compared

Premise [I]: the existing UI is already a web app served by the server, so the cheapest route to "near-identical UI" is a thin native shell around the same web bundle. Rewriting the UI (Flutter, React Native) throws away reuse.

| Option | Shared UI code | Platforms | Size | Security notes | Signing / notarization | Auto-update |
|---|---|---|---|---|---|---|
| **Electron** (already in repo, v45.2.3) | 100% of `public/` | Win, Mac, Linux; no Android | Large (full Chromium) [U: typically ~100 MB installer; not measured here] | Mature; fuses already set [S repo] | Mac: Developer ID + notarization, $99/yr [S Apple page]. Win: unsigned now [S WINDOWS-APP.md] | electron-updater or Squirrel. Hosted `update.electronjs.org` needs a **public** GitHub repo and code-signed macOS builds [S electronjs.org]. Repo is private per owner memory, so self-host a feed [I] |
| **Tauri 2** (Rust shell) | 100% (system WebView) | Win, Mac, Linux, Android, iOS [S tauri.app mobile pages] | Small [U] | Smaller attack surface, Rust backend; capabilities model [U] | Same Apple/Windows certs; Android via Play or APK | Updater plugin: signature **mandatory**, cannot be disabled; configured for desktop only in the setup code [S v2.tauri.app/plugin/updater, Nov 2025]. Mobile updates = store or APK [I] |
| **Capacitor 8** (Dec 2025; 8.3.x in 2026) | 100% (wraps web build) | Android, iOS first-class; desktop via Electron/community [S ionic blog, newreleases; Electron path unverified] | Small APK [U] | Node 22+ build chain; Android target SDK 36 [S] | Play $25 once; APK self-signed | Play in-app updates or APK self-update [U] |
| **Flutter** | 0% (rewrite in Dart) | Desktop supported [S docs.flutter.dev]; mobile stable [U] | Medium [U] | Good | Same per-OS signing | Per-store or custom [U] |
| **React Native** (+ RNW 0.84, June 2026) | 0% (rewrite in React) | RNW for Windows current [S devblogs v0.84]; RN macOS status **not verified** | Medium [U] | Good | Per-OS | Per-store or custom [U] |

Signing and distribution facts (primary-sourced where marked):
- **Apple:** $99 per year [S developer.apple.com/programs]. Developer ID + notarization for Mac apps outside the App Store is included [S Apple programs page; notarization steps S Apple doc page was 404 in fetch, steps from general knowledge U].
- **Windows code signing:** Azure Artifact Signing Basic $9.99/month, 5,000 signatures [S azure.microsoft.com via search snippet, prices flagged as estimates]. **Eligibility for an Israel-based owner is unverified**: a Microsoft Q&A user says US/Canada/EU/UK only [U]. Fallback is an OV certificate from a commercial CA; price not checked [U].
- **Google Play:** $25 one-time, identity verification required [S support.google.com/googleplay/android-developer/answer/6112435].
- **Android sideload (APK):** Developer verification enforced **from 2026-09-30** only for apps from participating stores in Brazil, Indonesia, Singapore, Thailand. FAQ: direct sideloads "won't apply to your app yet" but global enforcement planned for 2027 [S developer.android.com/developer-verification/guides/faq, updated Jul 15 2026]. Full distribution account costs $25 in the Console; limited account is free for up to 20 devices [S FAQ]. Power users can enable an "advanced flow" for unverified apps: one-time setup, 24-hour wait, restart, biometric or PIN [S FAQ].

**Shared-UI risk for mobile:** on Android the client cannot use `ssh.exe`. Two paths: (a) Tailscale on the phone, HTTPS to the tailnet address (already supported by the server); (b) an embedded SSH library [I]. Path (a) reuses existing server code.

## 3. Server on Windows, Linux, macOS

| Platform | Core (Node chat, bots, Kanban, browser) | Claude Code | Codex | Virtual computer | Host control |
|---|---|---|---|---|---|
| Linux | Yes (shipped) | Yes | Yes | Yes (KVM) | Yes on X11 |
| Windows | Likely; code has win32 branches (`claude.mjs`, `codex.mjs`, `claude-login.mjs`) [S src] | Native Windows supported; Git Bash optional, PowerShell fallback [S code.claude.com setup page, search snippet] | Native Windows sandbox exists; OpenAI "experimental" label status unsettled [U, third-party sources] | No KVM. Hyper-V only as a roadmap candidate [S docs/ROADMAP.md] | Not implemented (unsupported) [S] |
| macOS | Likely [I] | Yes [U] | Yes [U] | No KVM. Apple Virtualization framework runs Linux guests [S developer.apple.com search snippet]; new provider needed [I] | Not implemented [S] |

Work to ship the server on Win and Mac [I]: replace `install.sh` and systemd supervisor with per-OS service install (Task Scheduler/launchd); path and shell handling; test suite runs Linux-only parts [S docs/VALIDATION.md implied]; Docker on Windows via WSL2 is the cheapest "server on Windows" path, but Docker is currently untested and has no computer [S DEPLOYMENT.md].

## 4. Push for proactive bots on Android without Google

| Option | How | Pros | Cons | Fit |
|---|---|---|---|---|
| **FCM** | Google push | Reliable, free, standard | Needs Google Play services and a Google project; the owner wants to avoid it | Fallback only |
| **UnifiedPush via ntfy** | ntfy app acts as distributor; self-hosted ntfy server [S docs.ntfy.sh] | No Firebase on self-hosted or F-Droid builds; self-host on the StellarCortex box or tailnet | Without Play services, reliability and battery were poor at first (UnifiedPush author, Jan 2026 F-Droid post [S]); ntfy keeps a foreground service with a permanent notification for instant delivery [S]; iOS not supported [S etke.cc] | **Recommended primary** |
| Self-hosted ntfy alone (no UnifiedPush) | App subscribes to ntfy directly | Simple | Needs ntfy app or own client code | Also viable |

Design note [I]: push payload carries only "wake up, check server", never bot content, because bot output is untrusted data under the existing security model.

## 5. Recommendation

**Keep one web UI as the single source of truth. Desktop: Electron (already in repo). Android: Capacitor wrapping the same web build. Push: ntfy self-hosted, UnifiedPush primary, FCM optional.** Android talks to the server over Tailscale HTTPS.

Why: lowest rewrite, existing Electron code reused, one UI codebase, Google-free push. Costs: Apple $99/yr, Play $25 once, Windows cert (cost and Israel eligibility open), APK registration risk in 2027.

Runner-up: **Tauri 2 for everything** (one shell, smaller binaries) if the owner accepts Rust and if Tauri mobile updater and push are confirmed. Revisit trigger: Tauri docs confirm mobile update and push support, or Electron size becomes a complaint.

Next step (a spike, not a commitment): build the existing `public/` UI inside a Capacitor Android shell and measure APK size, WebView behavior with the tailnet HTTPS URL, and UnifiedPush delivery over 24 h on a non-Google phone.

## 6. Open items and unverified

- Azure Artifact Signing eligibility for Israel: unknown, check the prerequisites page.
- OV certificate price: not checked.
- Electron, Tauri and Capacitor binary sizes: typical values, not measured.
- RN for macOS status: not found.
- Tauri mobile push plugin: not found.
- Capacitor-on-Electron: not verified.
- Codex native Windows support label: conflicting third-party sources.

## Sources

- https://developer.android.com/developer-verification/guides/faq
- https://support.google.com/googleplay/android-developer/answer/6112435
- https://developer.apple.com/programs/
- https://v2.tauri.app/plugin/updater/
- https://v2.tauri.app/distribute/
- https://www.electronjs.org/docs/latest/tutorial/updates
- https://docs.ntfy.sh/subscribe/phone/
- https://docs.flutter.dev/platform-integration/desktop
- https://code.claude.com/docs/en/setup
- https://azure.microsoft.com/pricing/details/artifact-signing/
- https://microsoft.github.io/react-native-windows/docs/parity-status
- https://nextcloud.com/blog/unifiedpush-android-nextcloud-talk/
- https://f-droid.org/de/2026/01/08/unifiedpush-5-years.html
- Local: D:\stellarcortex\README.md, docs\DEPLOYMENT.md, docs\COMPUTER.md, docs\WINDOWS-APP.md, docs\UPDATES.md, docs\ROADMAP.md, desktop\package.json, package.json, install.sh
