# Decisions log (Defaults rule)

Each entry: ID, decision, one-line reason. Closed spec decisions (D-01..D-25) are not repeated here.

| ID | Decision | Reason |
|---|---|---|
| DL-001 | Chromium in the bot computer comes from Debian stable + security via apt pinning on the Ubuntu 26.04 base. | Ubuntu ships Chromium only as a snap, which cannot run in a container; Debian's build is free and gets security updates. |
| DL-002 | Coding engines are installed into the bot's home volume from npm on first start, never baked into the image. | C-06: nothing proprietary is redistributed, even inside a locally built image. |
| DL-003 | The bot-computer image is always built locally on the operator's machine (FR-PC-07 "builds"), never pushed to a registry. | Keeps C-06 and avoids paid/public registries. |
| DL-004 | VNC inside the container listens on loopback only, with a random per-bot password injected as a Podman secret; noVNC's port is published to host loopback only and reached through the server's authenticated proxy. | Secure by default; no open VNC. |
| DL-005 | TypeScript 5.9 (not 7.x) and Vite 7 / Vitest 3. | Most widely supported by Electron, Capacitor and Vite tooling today. |
| DL-006 | Desktop Google login uses the fixed loopback redirect `http://localhost:47823/oauth/callback`, registered on the operator's Web client; the client forwards code + PKCE verifier to the server, which exchanges it. | Google Web clients do not accept LAN IPs or self-signed hosts as redirects; the server stays the relying party (D-13). |
| DL-007 | Browser UI login (D-16) uses the same loopback redirect; if nothing listens on the browser's machine, the user pastes the redirected URL into the page. | Works without a public domain or paid certificate. |
| DL-008 | Other users are allowlisted by Google email; the `sub` is bound on their first verified login and used as the key from then on. | The owner knows emails, not `sub` values; `email_verified` is required. |
| DL-009 | The server's TLS key is ECDSA P-256 in a self-signed X.509 certificate; clients pin the SHA-256 of its SubjectPublicKeyInfo. | Chromium (Electron/WebView) does not accept Ed25519 TLS certificates. |
| DL-010 | Master key wrapping order: OS keystore (Windows DPAPI, macOS Keychain, Linux Secret Service via `secret-tool`) if usable, else Argon2id passphrase stored in a file outside the data folder (created by the installer, mode 0600). | NFR-SEC-04: a dump of the data folder alone reveals nothing. |
| DL-011 | The TLS private key is sealed with the master key at rest. | It is a secret; NFR-SEC-04. |
| DL-012 | The first device is approved on the server console (`advence pair`); later devices are approved by the owner on a paired device. Approval requires typing the 6-digit code shown on the new device. | There is no owner before the first device; typing the code forces a real comparison. |
| DL-013 | Session tokens: 32 random bytes, stored only as SHA-256, 15 min lifetime; refresh needs a valid device signature from an active device bound to an allowlisted user. | NFR-SEC-03. |
| DL-014 | Request nonces are kept in SQLite for the 60 s skew window, so replays are refused across restarts too. | NFR-SEC-02. |
| DL-015 | Signed WebSocket frames: an `auth` frame within 5 s of connect, then every client frame signed; session expiry requires a fresh `auth` frame on the same socket. | Browsers cannot set headers on WebSocket; NFR-SEC-02/03. |
| DL-016 | Server traffic from the native shells goes through their native layer, which pins the server key: Electron's main process (Node `https`/`ws` with a pinned agent, renderer CSP `connect-src 'self'`), Android's Capacitor plugin (OkHttp). | WebView/renderer pinning is unreliable (Chromium caches certificate verdicts), and the renderer then has no network access at all. |
| DL-017 | Encrypted chat history is searched through an in-memory SQLite FTS5 index rebuilt at start. | A plaintext FTS index on disk would defeat NFR-SEC-04. |
| DL-018 | On a Linux desktop with no keyring (safeStorage backend `basic_text`), the device key file falls back to owner-only permissions. | Linux desktops normally have libsecret/kwallet; refusing would lock those users out. |
| DL-019 | E2E tests that launch Electron as root drop to an unprivileged user; the app always enables Chromium's sandbox. | Chromium refuses its sandbox as root; the product must never disable it. |
| DL-020 | Windows and macOS installer jobs run on demand (`installers` workflow); Linux, tests, image and APK run on every push. | macOS/Windows runner minutes count 10x/2x against the free private-repo quota (C-04). |
| DL-021 | Android release APK is signed only when a keystore is supplied as a CI secret; otherwise it is built unsigned. The debug APK is used for emulator tests. | No keystore may enter the repo; signing keys are the owner's to create. |
| DL-022 | Android ships one universal APK plus per-ABI APKs (arm64-v8a, x86_64), minSdk 28. | FR-CLI-02 asks for Android 9+, arm64 + x86_64; a universal APK is simplest to sideload. |
| DL-023 | Android QR scanning uses the WebView camera (getUserMedia + jsQR) with the CAMERA permission; no extra native scanner. | Reuses the UI scanner; fewer native components. |
