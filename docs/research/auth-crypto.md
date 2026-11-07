# StellarCortex Advence - Research brief: auth, Gmail access, E2E, browser UI

Date: 2026-11-07. Researcher: Haiku 5.5 agent. Scope: research only, no code.
Sources were checked with WebFetch/WebSearch this session. "Unverified" = not confirmed in a primary source.

## Bottom line

1. Login: server is the OIDC relying party. Operator owns one Google "Web" OAuth client per deployment; clients never hold a Google secret. Desktop uses system browser + loopback to the server; Android uses Credential Manager and sends the ID token to the server for verification.
2. Gmail: do not request Gmail scopes in v1. If needed later, use the operator's own Google Cloud project, Testing mode (<=100 test users, 7-day consent) or Internal (Workspace). Public Gmail access with restricted scopes = verification + CASA; treat as a separate project.
3. E2E: be honest. The server runs bots, so it sees plaintext. Offer TLS 1.3 with a pinned server key plus per-device keys and an encrypted key-backup blob. Do not market "E2E" against the server operator. MLS is not needed for one server and N devices.
4. Browser UI: off by default. If enabled, bind 127.0.0.1 only. Code trust must come from the signed desktop/Android bundle, not from the server that hosts the UI.

## Key facts (sourced)

- Desktop OAuth: use a Desktop-app client type; loopback `http://127.0.0.1:port` with exact redirect match; custom URI schemes are no longer supported; PKCE "always"; desktop secrets are not confidential. Source: https://developers.google.com/identity/protocols/oauth2/native-app (no date on page).
- Loopback is deprecated for Android and iOS clients; Android uses Credential Manager. Source: same page.
- Android Sign in with Google: pass the **Web** client ID as `serverClientId`, not the Android client ID; server checks `aud` against the Web client ID. Sources: https://developer.android.com/identity/sign-in/credential-manager-siwg-implementation and https://auth0.com/docs/authenticate/identity-providers/social-identity-providers/google-native (third-party guide, summary).
- ID token verification: check signature via JWKS (`https://www.googleapis.com/oauth2/v3/certs`), `iss`, `aud`, `exp`; `hd` only if you need a Workspace domain; use `sub` as the stable user key, not email; tokeninfo is debug-only. Source: https://developers.google.com/identity/sign-in/web/backend-auth (no date).
- Gmail sensitivity labels (Google scopes page): `gmail.send` = Sensitive; `gmail.readonly`, `gmail.compose`, `gmail.modify`, `gmail.metadata`, `gmail.insert`, `gmail.settings.basic`, `gmail.settings.sharing`, `mail.google.com` = Restricted; `gmail.labels` = Non-sensitive. Source: https://developers.google.com/workspace/gmail/api/auth/scopes (no date).
- Restricted scopes + access through a third-party server require a security assessment (CASA via App Defense Alliance); reverify at least every 12 months; restricted review "can potentially take several weeks." Cost not stated by Google. Source: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
- Testing mode: up to 100 test users; test authorizations and refresh tokens expire after 7 days (except basic identity scopes only). Source: https://support.google.com/cloud/answer/15549945 and https://developers.google.com/identity/protocols/oauth2
- Refresh token cap: 100 refresh tokens per Google Account per OAuth client; newest replaces oldest silently. Source: https://developers.google.com/identity/protocols/oauth2
- Internal user type: limited to members of the Google Cloud Organization (`org_internal` error for others). Whether Internal skips verification was NOT confirmed. Source: https://support.google.com/cloud/answer/15549945
- Google's official Gmail MCP server (Developer Preview): endpoint `https://gmailmcp.googleapis.com/mcp/v1`; tools include search_threads, get_thread, get_message, create_draft, label/unlabel, list_labels, list_drafts; no send tool listed. Scopes and auth are not stated on Google's page (third-party sources say gmail.readonly + gmail.compose; unverified). Source: https://developers.google.com/workspace/gmail/api/reference/mcp
- MLS (RFC 9420, July 2023, Standards Track): group key agreement with forward secrecy and post-compromise security; assumes an Authentication Service and an untrusted-ish Delivery Service; does not define multi-device key backup. Source: https://www.rfc-editor.org/rfc/rfc9420.html
- Multi-device over MLS exists only as an IETF individual draft (draft-mcmillion-mls-subgroups-00, March 2024, not an RFC). Source: https://www.ietf.org/id/draft-mcmillion-mls-subgroups-00.html
- WebCrypto (SubtleCrypto): restricted to secure contexts (MDN names HTTPS; localhost treatment not stated on the fetched page); "Baseline widely available" since Sept 2017; page last modified 2025-09-12. Source: https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto
- WebAuthn PRF (to derive a stable key from a passkey): mid-2026 support is uneven. Windows Chrome 147+ and Firefox 148+ reported working; Safari has a 2026-03 bug on hmac-secret output; some password managers unsupported. Mostly third-party/community data. Sources: https://mera.category.xyz/authenticator-support/ and https://bugs.webkit.org/show_bug.cgi?id=311099
- Served-JS trust problem: a server can swap JS for a malicious version; signing alone is defeated by stripping signatures; need browser/app-level verification or pinned code. Source: 2012-2013 W3C WebCrypto threads (background only) at https://lists.w3.org/Archives/Public/public-webcrypto-comments/2013May/0010.html and https://cryptologie.net/posts/browser-end-to-end-encryption/ (2018).

## 1. Login with Google (self-hosted server + Win/Linux/Mac + Android)

Owner of the OAuth client:
- Option A, vendor-owned shared client: one client ID in all installs. Cons: user cap, shared quota, revocation risk (precedent: rclone shared client retirement, per earlier brain note), secret inside binaries. Not recommended.
- Option B, operator-owned client per deployment (recommended): operator creates a Web client in their own GCP project; server holds the secret. Android needs its own Android client (package + SHA-1) plus the Web client ID for `serverClientId`. Desktop uses the server flow, so no desktop client secret is shipped.

Flow (recommended):
- Desktop: app opens system browser to server `/login`; server runs Authorization Code + PKCE with Google; server returns to a loopback listener on the desktop or via the existing SSH tunnel; app receives a server session token (not a Google token).
- Android: Credential Manager gets Google ID token; app posts it to server; server verifies and issues session. Sign-out calls `clearCredentialState()`.
- Authorization is separate: allowlist by Google `sub` (or `hd` for a domain). Google login identifies the person; it does not grant bot access.
- Keep the restricted SSH key as admin/break-glass path.

Unverified: exact behaviour of Android client + Web client ID combo on every Android version; test on a device.

## 2. Automatic Gmail/Google API connections for the user

Recommendation: v1 = no Gmail scopes. Phase 2 options:

| Option | Pros | Cons | Fit |
|---|---|---|---|
| A. Own GCP project, External, Testing | No review; free | <=100 test users; 7-day consent; user must re-consent weekly | Small private team, personal use |
| B. Internal (Workspace org) | No public review; longer tokens (not verified) | Only org members | Company use |
| C. Public app, restricted Gmail scopes | Any user | Verification + CASA (annual, cost and time not stated by Google; vendor quotes only) | Only if a product is sold |
| D. Google Gmail MCP (preview) | Official; read + draft only; no send | Preview; scopes/auth not stated on Google's page | Candidate connector; test first |

Pitfalls:
- `gmail.send` is Sensitive (not Restricted), but any mail read is Restricted.
- Unverified: whether a self-hosted server run by each user counts as "through a third-party server" for CASA. Ask Google before choosing C.
- Store refresh tokens encrypted at rest; plan for the 100-per-client cap.

## 3. End-to-end encryption across the interface

What E2E can mean here:
- The bot runs on the server, so the server must see plaintext. True E2E against the server operator is impossible for bot-processed content.
- What is achievable: (a) confidentiality and integrity on the wire to a pinned server identity; (b) per-device keys so a stolen device can be revoked; (c) encrypted at-rest blobs whose key the operator holds (or derives from a passphrase); (d) E2E only for content that bots do not read, if such a path is added later.

Options:

| Option | Pros | Cons | Fit |
|---|---|---|---|
| TLS 1.3 + pinned server SPKI (QR at install) | Standard, simple | Pinning needs rotation plan | Recommended baseline |
| Noise (IK/XX) app-layer over any transport | No PKI; small | Custom implementation risk; no source fetched this session | Alternative if no TLS PKI |
| Signal / Double Ratchet | Strong for async peers | Built for peer-to-peer, not one server | Only for human-to-human chat |
| MLS (RFC 9420) | Group FS/PCS | Groups of many members; multi-device only a draft | Overkill for server-client |

Device pairing and backup (recommended):
- Each device generates its own key pair; admin approves the device (QR + short verification code shown on both sides).
- Key backup: passphrase-derived key (Argon2id, unverified parameters) wraps a key bundle; store the blob on the server. Optional passkey PRF as second factor where support exists.

## 4. Optional encrypted browser UI

- Default: no browser UI. Native clients only.
- If enabled: bind to 127.0.0.1; no LAN exposure. WebCrypto works in secure contexts (HTTPS; localhost is generally treated as secure, verify in target browsers).
- Trust problem: a UI served by the same server can be swapped by that server. Preferred: the desktop/Android app bundles the web UI and loads it locally, so the app signature is the trust root.
- If the server must serve the UI: strict CSP, Subresource Integrity, and the expected hashes pinned in the native client (not fetched from the server).
- Passkeys (WebAuthn) bind to the origin and resist phishing; use them for login. Do not depend on PRF alone for key material until support is consistent; keep a passphrase fallback.

## Risks and unknowns

- Google policy changes (verification thresholds, CASA cost) - re-check before any decision.
- Gmail MCP status and scopes not stated on Google's page.
- CASA applicability to self-hosted server: unresolved.
- WebAuthn PRF cross-browser behaviour: community data only.
- Not found: current (2026) public CASA cost; Internal-app verification exemption text.

## Next steps (for CEO)

1. Decide: server-side OIDC with operator-owned client (Option B). Confirm with user.
2. Keep Gmail out of v1; ask user which Google account type (Workspace or personal) for phase 2.
3. Accept honest E2E wording with the user; choose TLS + pinned key baseline.
4. Desktop-bundled UI as default trust root if a browser UI is ever wanted.

## Source list

- https://developers.google.com/identity/protocols/oauth2/native-app
- https://developers.google.com/identity/sign-in/web/backend-auth
- https://developer.android.com/identity/sign-in/credential-manager-siwg-implementation
- https://developers.google.com/identity/protocols/oauth2
- https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
- https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification
- https://support.google.com/cloud/answer/15549945
- https://developers.google.com/workspace/gmail/api/auth/scopes
- https://developers.google.com/workspace/gmail/api/reference/mcp
- https://www.rfc-editor.org/rfc/rfc9420.html
- https://www.ietf.org/id/draft-mcmillion-mls-subgroups-00.html
- https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto
- https://mera.category.xyz/authenticator-support/
- https://bugs.webkit.org/show_bug.cgi?id=311099
- https://auth0.com/docs/authenticate/identity-providers/social-identity-providers/google-native
