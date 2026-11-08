# StellarCortex Advence

Self-hosted multi-Bot agent server with desktop (Windows, macOS, Linux) and Android clients.
Each Bot has its own computer (a rootless Podman container with a desktop and browser), memory,
skills, routines, Google and MCP tools. Encrypted from your devices to your server; your server
runs the Bots and can read their content. Private, proprietary project (`LICENSE`).

## Use it

- Server: one line per OS from the latest release, see `docs/admin-guide.md`.
  - Linux and macOS: `curl -fsSL https://github.com/avitwil/stellarcortex-advence/releases/latest/download/install.sh | sh`
  - Windows: `powershell -ExecutionPolicy Bypass -c "irm https://github.com/avitwil/stellarcortex-advence/releases/latest/download/install.ps1 | iex"`
- Apps and everyday use: `docs/user-guide.md`.
- Releasing and signing: `docs/release.md`.

## Repository

- `apps/server` Node 22 + TypeScript server (Fastify, ws, SQLite), `apps/server/launcher` the
  service entry that switches versions and rolls back failed updates
- `apps/ui` React UI, the single UI source for every client
- `apps/desktop` Electron shell
- `apps/android` Capacitor shell
- `packages/protocol` shared API schemas, crypto and release signing
- `images/bot-computer` Containerfile for the per-Bot computer
- `install/` the one-line server installers
- `scripts/release/` release key, bundles, manifests, signing and verification
- `docs/` requirements (single source of truth), decisions, phase reports, manual checks, guides

## Develop

```sh
pnpm install
pnpm check        # typecheck, brand check, license audit, cost audit, unit and integration tests
pnpm test:e2e     # browser and Electron end-to-end tests
```

Third-party components are listed in `THIRD_PARTY_NOTICES.md`.
