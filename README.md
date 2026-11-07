# StellarCortex Advence

Self-hosted multi-bot agent server with desktop (Windows, macOS, Linux) and Android
clients. Private, proprietary project. See `docs/requirements.md` (single source of truth).

- `apps/server` Node 22 + TypeScript server (Fastify, ws, SQLite)
- `apps/ui` React UI, the single UI source for every client
- `apps/desktop` Electron shell
- `apps/android` Capacitor shell
- `packages/protocol` shared API schemas and crypto helpers
- `packages/engines` coding engine adapters
- `images/bot-computer` Containerfile for the per-bot computer
- `docs/` requirements, decisions, spikes, phase reports, manual checks

Development: `pnpm install`, `pnpm check` (typecheck, brand check, license check, tests).
