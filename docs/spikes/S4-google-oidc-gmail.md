# Spike S4: Google OIDC + Gmail in Testing mode

Phase: P0. Requirement refs: D-13, D-14, FR-GGL-01..06.

## What ran here
- Google's discovery document (`https://accounts.google.com/.well-known/openid-configuration`)
  is reachable from the server host. ID token verification uses `jose` with the JWKS
  from `https://www.googleapis.com/oauth2/v3/certs`, and checks `iss`
  (`https://accounts.google.com` or `accounts.google.com`), `aud` (the Web client ID),
  `exp`, and `email_verified`. The account key is `sub`.
- The full flow (auth URL + PKCE S256 -> loopback redirect -> code exchange on the server
  -> ID token verification -> allowlist) is covered by automated tests against a local
  mock OIDC provider that signs real RS256 tokens (P1 tests).

## Not runnable here
A real login and a Gmail call need the operator's own Google Cloud project and a real
Google account. Manual check MC-S4-GOOGLE in `docs/manual-checks.md`.

## Findings
- Google Web OAuth clients accept `http://localhost:<port>` redirect URIs but not raw
  LAN IPs or self-signed HTTPS hosts. **Decision:** the desktop client listens on
  `http://localhost:47823/oauth/callback` (fixed port, registered once by the wizard)
  and forwards the code + PKCE verifier to the server over the pinned TLS connection.
  The server, which holds the client secret, exchanges the code. This is the one
  plaintext-HTTP exception in NFR-SEC-01.
- Testing mode: refresh tokens for non-basic scopes expire after 7 days; at most 100 test
  users. FR-GGL-05 handles the expiry.
- `gmail.modify` is a restricted scope; in Testing mode with the operator's own project it
  needs no verification and no CASA (C-04).
