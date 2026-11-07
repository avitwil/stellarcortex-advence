# StellarCortex Advence: Requirements Specification v1.0

- **Status:** Final for implementation.
- **Date:** 2026-11-07.
- **Owner:** avitwil.
- **Audience:** the implementing agent or team. This document is self-contained. Every decision is already made. If something seems missing, apply the "Defaults rule" in section 2 and do not stop to ask.

---

## 0. How to use this document

1. Read sections 1 to 4 first: context, rules, decisions and architecture.
2. Build phase by phase (section 7). Each phase has acceptance criteria (AC). A phase is done only when all of its AC pass.
3. Requirements have IDs (for example `FR-CHAT-03`). Reference the ID in commits, tests and PRs.
4. Background research with sources is in the same folder (`research-*.md`). It is for reference. This document overrides it wherever they differ.

---

## 1. Context

### 1.1 What exists today (reference only)
**StellarCortex** (public repo `github.com/avitwil/stellarcortex`, v0.1.3, local copy `D:\stellarcortex`) is a self-hosted multi-bot agent server.
- **Server:** Node.js 22, vanilla-JS web UI in `public/`, port 4317 on loopback. Provider CLIs: Claude Code, Codex, HTTP/local models. Also Kanban, routines and webhooks.
- **Bot computer:** one QEMU/KVM Ubuntu VM. Each bot gets its own Linux user and its own Xfce + TigerVNC + noVNC desktop.
- **Host control:** a per-bot owner option, Linux X11 only.
- **Auth:** an installation access key. Remote access goes through an SSH tunnel or Tailscale.
- **Clients:** a Windows Electron client ("StellarCortex Desktop") that connects through a restricted SSH tunnel.
- **Updates:** signed (Ed25519) GitHub releases, with a supervisor that stages each update and can roll it back.
- **Platform:** the server is Linux only.

### 1.2 What this project is
**StellarCortex Advence** is a new product, rewritten from scratch. It makes StellarCortex look and behave like **Grok Bot** (xAI/SpaceXAI + Cursor, beta Aug 2026), and adds:
- coding at Claude Code / Cursor / Codex level,
- container-based bot computers,
- a self-learning loop,
- Obsidian-compatible memory,
- full MCP and third-party skills,
- Google login and Google integrations,
- encrypted clients on Windows, Linux, macOS and Android,
- proactive bots.

### 1.3 Hard constraints (non-negotiable)
| ID | Constraint | Source |
|---|---|---|
| C-01 | All work happens in a **new private repo** `github.com/avitwil/stellarcortex-advence`, spelled exactly this way. | User |
| C-02 | **Do not touch the original** (`avitwil/stellarcortex`, `D:\stellarcortex`, its site, releases or installs). Read it for reference only. Copy no code from it without rewriting. | User |
| C-03 | **Rewrite from scratch.** The old code is a reference, not a base. | User decision |
| C-04 | **Everything must stay free:** no paid service, license, certificate, store fee or audit. Users pay only for model API keys they choose to bring. | User: "כל ההחלטות צריכות להישאר במצב חינמי" |
| C-05 | **UI layout and interface follow Grok Bot**, but are not a pixel-exact copy. Use **our own logo, name, icons and wording**. Never use "Grok", "xAI", "SpaceX", "Cursor" or "Hark" in the product, in feature names or in assets. | User: "לא צריך העתקה מדוייקת אבל פריסה וממשק אפשר כמובן נשתמש בלוגו שלנו" |
| C-06 | Do not bundle or redistribute Obsidian or the Claude Agent SDK. Dependencies are installed from their official registries at install time. | Licenses |
| C-07 | Do not push, publish, release or delete anything outward-facing without the owner's explicit approval. Agents prepare; the owner approves. | Owner rule |

---

## 2. Global rules for the implementer

- **Defaults rule:** if a detail is not specified, pick the simplest option that is free, secure by default and consistent with this document. Record it in `docs/decisions.md` with a one-line reason, then continue. Stop and ask only when a choice would break a constraint in 1.3.
- **Scope rule:** build only what this document lists. Section 9 lists out-of-scope items. Do not add features, settings or knobs that are not listed.
- **Testing:** every FR/NFR needs at least one automated test unless its AC says "manual". Use TDD where practical.
- **Languages:** the UI is Hebrew and English, with full RTL support. Code, comments and docs are in English.
- **Themes:** light and dark.

---

## 3. Decisions (closed)

| # | Topic | Decision | Why |
|---|---|---|---|
| D-01 | Code base | Rewrite from scratch, using TypeScript throughout. | User decision; one language across server and clients. |
| D-02 | Server stack | Node.js 22 LTS + TypeScript, Fastify (HTTP) + `ws` (WebSocket), SQLite (`better-sqlite3`) for state, files for memory and skills. | Free, cross-platform, fits the Agent SDK (TS). |
| D-03 | UI stack | One web UI: React 18 + TypeScript + Vite. It is the **single UI source** for every client. | Near-identical desktop and Android UI from one codebase. |
| D-04 | Desktop clients | Electron (latest stable) wrapping the bundled UI, for Windows x64, macOS (Apple silicon + Intel) and Linux x64 (AppImage + .deb). | Proven in the old product; one shell for 3 OSes. |
| D-05 | Android client | Capacitor (latest stable) wrapping the same UI. Android 9+. Distributed as a signed APK, not through Google Play. | Free (C-04); shares UI code. |
| D-06 | Code signing | **No paid signing.** Windows: unsigned (SmartScreen warning documented). macOS: ad-hoc signed, not notarized (the first-run "Open anyway" step is documented). Android: APK signed with our own free keystore. Release artifacts are additionally signed with our Ed25519 release key. | C-04. |
| D-07 | Models | The user picks per bot in Settings from three sources: **(a) local** OpenAI-compatible servers (llama.cpp, Ollama, LM Studio, vLLM), **(b) own API keys** (Anthropic, OpenAI, any OpenAI-compatible), **(c) subscription login** (Claude / ChatGPT) **for the owner's personal use only**, with a visible notice in the UI. | User decision. Option (c) stays personal-use only per the Anthropic Agent SDK terms. |
| D-08 | Coding engines | Pluggable engine interface with 3 adapters: **Claude Agent SDK** (API key, or subscription per D-07c through the official Claude Code CLI), **OpenAI Codex CLI** (`codex exec`), **OpenCode** (MIT, for local and any API models). All three run **inside the bot's container**. Cursor CLI is not included. | Research: best capability, clear licenses. |
| D-09 | Bot computer | **One container per bot** running the same desktop stack as today: Ubuntu 26.04 base, Xfce, TigerVNC, noVNC (MPL-2.0), Chromium **with its sandbox on**, non-root user, persistent home volume. | User requirement: same computer, in a container. |
| D-10 | Container runtime | **Podman** on every OS. Linux: rootless Podman, with GPU through NVIDIA CDI when present. Windows: Podman machine on WSL2. macOS: Podman machine (CPU only). **Never Docker Desktop.** | Free (Docker Desktop is paid above 250 staff or $10M revenue). |
| D-11 | Server OS | The server runs on **Linux, Windows 10/11 and macOS 14+**. Each OS gets its own service install: systemd user unit, a Windows Scheduled Task (or service) and a launchd agent. | User requirement. |
| D-12 | Host control | Per-bot owner option ("this bot controls the host"). v1: Linux (X11 and Wayland via `ydotool`), Windows (native input APIs) and macOS (Accessibility API). | Parity with today and with all 3 OSes. |
| D-13 | Login | **Sign in with Google (OIDC)** replaces the access-key and SSH-key pairing. The server is the OIDC relying party, using an **operator-owned Google "Web" OAuth client** in the operator's own free Google Cloud project. Desktop uses the system browser with PKCE and a loopback redirect to the server. Android uses Credential Manager with the Web client ID as `serverClientId` and sends the ID token to the server. Authorization is an allowlist by Google `sub`. The first login becomes owner. | User requirement; free. |
| D-14 | Google integrations | "Connect Google" runs automatically **after login** in the **same operator project**. Built-in connectors: Gmail (read, modify, send), Calendar, Drive, Contacts. The project stays in **Testing mode** (free, no verification, no CASA, up to 100 users). The server tracks the **7-day refresh-token expiry** and reminds the user with one-tap re-consent before expiry. A setup wizard walks the operator through creating the Google project, with exact steps and links. | User requirement plus C-04 (CASA is paid). |
| D-15 | Encryption | See section 6. Short form: TLS 1.3 with a server key **pinned at pairing (QR)**, per-device key pairs, signed requests, encryption at rest for secrets and memory, and an encrypted key backup. The UI must say clearly that the server you own can read bot content, because it runs the bots. | Honest "E2E" between your devices and your server. |
| D-16 | Browser UI | **Off by default.** The owner can enable it in Settings. When on, it is reachable from **paired devices only, after Google login and device pairing**, over the same pinned TLS. It is never open to the internet without login. The UI bundle is served with a strict CSP and SRI. | User decision. |
| D-17 | Remote reachability | The server listens on one HTTPS port (default 4443). The user reaches it over LAN, a router port forward, or any VPN they already use. The docs cover Tailscale and Cloudflare Tunnel (both free tiers) as optional. The product depends on none of them. | Free; no lock-in. |
| D-18 | Push notifications | Android: **UnifiedPush through a self-hosted ntfy** that the server runs embedded or as a sidecar. FCM is an optional fallback that is off by default. Desktop: native OS notifications through the open client connection. The payload carries only "wake up + id", never content. | Free, Google-free. |
| D-19 | Proactive bots | **Full autonomy** for bots the owner marks "Proactive". External events (mail, schedule, watcher, webhook, MCP notification) may trigger actions, including outbound actions, with **no approval prompt**. Non-proactive bots keep the old rule: only the owner or other in-tool bots can instruct them. | User decision (chose full autonomy over notify-only). |
| D-20 | Memory | A plain **Markdown vault, Obsidian-compatible** (YAML frontmatter, `[[wikilinks]]`, folders). It is read and written by our own code. Obsidian is never bundled. The user may open the vault in their own Obsidian. | Obsidian terms forbid redistribution. |
| D-21 | Learning | Hermes-style learn pass + deterministic write guard + **curator agent** that archives and never deletes. LLM consolidation is off by default. | Research recommendation. |
| D-22 | Skills format | **Agent Skills open standard** (`SKILL.md`, agentskills.io spec), including the standard fields only. | Portable across tools. |
| D-23 | MCP | Client and server support for **MCP spec 2026-07-28**, with fallback to **2025-11-25**. | Full MCP support with interop. |
| D-24 | Updates | Signed releases (Ed25519 key pinned in each install). The server updater stages the update, backs up and rolls back. Desktop uses `electron-updater` against a **self-hosted static feed**. Android checks the feed and offers the new signed APK. The feed URL is set at build time (default: the owner's VPS). | Private repo; free. |
| D-25 | Repo license | Proprietary, "All rights reserved", in a private repo. Third-party notices are kept in `THIRD_PARTY_NOTICES.md`. | Private project. |

---

## 4. Architecture

```
 ┌──────────────── Clients (one React UI) ────────────────┐
 │ Electron: Win / macOS / Linux   Capacitor: Android  [Browser UI, opt-in] │
 └───────────────▲─────────────────────────────▲──────────────┘
                 │ TLS 1.3, pinned key, device-signed requests, WS
 ┌───────────────┴──────────── Server (Node/TS) ──────────────────────┐
 │ Auth (Google OIDC, devices) │ API + WS gateway │ Push (ntfy)         │
 │ Bot runtime: orchestrator, model router, engines (SDK/Codex/OpenCode)│
 │ Proactivity: triggers, scheduler, watchers                           │
 │ Learning: learn pass, write guard, curator                           │
 │ Memory vault (Markdown) │ Skills store │ MCP client+server │ Google  │
 │ Container manager (Podman) │ Host-control adapter │ Updater          │
 └───────────────┬────────────────────────────────────────────────────┘
                 │ Podman API (rootless)
   ┌─────────────┴─────────────┐
   │ bot-1 container │ bot-2 … │  Xfce + TigerVNC + noVNC + Chromium + engines
   └───────────────────────────┘
```

**Repo layout (monorepo, pnpm workspaces):**
```
/apps/server        Node/TS server
/apps/ui            React UI (single source)
/apps/desktop       Electron shell
/apps/android       Capacitor shell
/packages/protocol  shared types, API schema (zod), crypto helpers
/packages/engines   engine adapters
/images/bot-computer  Containerfile for the bot computer
/docs               user + operator docs, decisions.md
```

---

## 5. Functional requirements

### 5.1 UI and layout (Grok Bot patterns, our branding)
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-UI-01 | **Chat-first home:** a left sidebar (desktop) or a home list (Android) of Bots and group chats, a "+" button (new Bot / new group chat) and global search. | All present on desktop and Android; search returns messages, Bots, group chats, files and routines. |
| FR-UI-02 | **Chat view:** text input, attachments (files and images), @mentions in group chats, threads, reactions, per-conversation drafts, streaming replies, and a markdown/code renderer. | Each element works; drafts persist across restart. |
| FR-UI-03 | **Bot profile:** opened by tapping the Bot name. Shows its routines, notification setting, Library, model and engine, computer status, "Proactive" toggle and "Host control" toggle. | Opens from the chat header on every client. |
| FR-UI-04 | **Library:** per-Bot and global. Pages, images, videos, files and links, grouped by date. | Items produced by a bot appear here within 5 s. |
| FR-UI-05 | **Computer view:** live view of the bot's desktop (noVNC). The owner can watch, **take over** (mouse and keyboard, for example for passwords, 2FA or CAPTCHA) and **hand back**. | Take-over and hand-back work on desktop and Android. The bot pauses its computer actions during take-over. |
| FR-UI-06 | **Routines tab:** list, next run, run history, pause/resume, delete and "run now". | All actions work and history shows status plus output link. |
| FR-UI-07 | **Settings:** account, models and keys, Google connections, MCP servers, skills, Bots, cloud computer, devices, appearance (light/dark), language (HE/EN), notifications, usage, browser UI toggle, updates, sign-out. | Every section exists and is functional. |
| FR-UI-08 | **Near-identical on desktop and Android:** same components and flows. Layout adapts responsively (sidebar becomes a list and stack navigation). | Visual review of the 10 main screens on both shows the same structure. |
| FR-UI-09 | **Branding:** our own name, logo, icon set and copy. No third-party marks. | A grep for "Grok", "xAI", "SpaceX", "Cursor" and "Hark" in UI strings and assets returns 0 hits. |
| FR-UI-10 | **RTL and i18n:** full Hebrew RTL and English LTR, switchable at runtime. | All strings come from i18n files; RTL is mirrored correctly. |

### 5.2 Bots and orchestration
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-BOT-01 | Create, edit and delete Bots: name, avatar, instructions, model source (D-07), engine (D-08) and tools. | CRUD works; a deleted Bot's container and data are archived, not destroyed. |
| FR-BOT-02 | **Primary Bot** ("chief of staff") coordinates the other Bots, hands tasks to them and reports back. | A task given to the primary Bot is delegated and the result is summarized back. |
| FR-BOT-03 | Group chats with several Bots and the owner. Bots hand work to each other. | Two bots complete a hand-off in a group chat. |
| FR-BOT-04 | Model router: each Bot uses its configured source (local / API key / subscription). Subscription mode shows a "personal use only" notice. | All three sources pass a chat round-trip test. |
| FR-BOT-05 | Usage view: tokens and cost per Bot per source, where the provider reports them. | Numbers match the provider responses in tests. |

### 5.3 Coding engine
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-CODE-01 | Engine interface (`start`, `send`, `stream`, `stop`, `resume`) with adapters for the Claude Agent SDK, Codex CLI and OpenCode. | The same task runs through each adapter. |
| FR-CODE-02 | Engines run **inside the Bot's container**, in a workspace folder on its persistent volume, with a terminal, git, language runtimes (Node, Python) and build tools preinstalled. | A bot clones a repo, edits it, runs tests and commits inside its container. |
| FR-CODE-03 | Capability parity target: multi-file edits, running shell and tests, reading output and iterating, subagents/plans, resuming sessions. | Benchmark: the bot fixes 3 seeded bugs in a sample repo and its tests pass, without help. |
| FR-CODE-04 | Live view of engine activity in chat: file diffs, commands, test output. | Diffs and commands stream to the UI. |
| FR-CODE-05 | Credentials for engines are injected into the container as env vars or files at start, never written into images or the repo. | A scan of the image layers finds no keys. |

### 5.4 Bot computer (containers)
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-PC-01 | Each Bot gets its own container from `images/bot-computer` (D-09), created automatically when the Bot is created. | A new Bot has a running desktop within 60 s once the image is cached. |
| FR-PC-02 | **Smooth like today:** desktop latency and frame rate at least equal to the current VM + noVNC experience. | Manual side-by-side check against the old VM; input latency under 100 ms on LAN. |
| FR-PC-03 | Persistent home volume per Bot (files, browser profile, logins) that survives restarts and updates. | Stop/start and update keep the data. |
| FR-PC-04 | Chromium runs with its sandbox on, as non-root, with a restrictive seccomp profile, and **without** `--no-sandbox` or `seccomp=unconfined`. | `chrome://sandbox` shows the sandbox on, in a test. |
| FR-PC-05 | Resource limits per container (CPU, RAM, disk), with editable defaults in Settings. | Limits are enforced (cgroup check). |
| FR-PC-06 | **Chat always works** even when the container runtime is missing or the image is still building. The computer then shows "preparing" with progress. | Chat test passes with Podman stopped. |
| FR-PC-07 | Install sets up Podman (Linux rootless; Windows Podman machine on WSL2; macOS Podman machine), builds or pulls the image and enables auto-start on boot (with an owner toggle). | A fresh install on each OS ends with a working Bot computer. |
| FR-PC-08 | GPU is passed to containers on Linux and Windows when an NVIDIA GPU with CDI is present. Otherwise the computer runs CPU only. | The GPU is visible inside the container on a CDI host. |
| FR-PC-09 | **Host control** (D-12) is a per-Bot owner toggle, off by default. | It works on all 3 OSes when on; it is blocked when off. |

### 5.5 Learning, skills and curator
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-LRN-01 | **Learn pass:** after a task (and every N=10 user turns or N=10 tool iterations, whichever comes first), a background review runs with memory and skill tools only. It captures user corrections, failures fixed and reusable techniques. Order: patch the loaded skill, then patch an existing skill, then update memory, then create a new skill. | A user correction in a session results in a memory or skill update. |
| FR-LRN-02 | **Deterministic write guard:** validates every memory or skill write against name rules, the size limit (skill body under 500 lines), duplicate detection, a do-not-capture list (secrets, tokens, personal data of third parties) and agent ownership. | Writes that break a rule are rejected, and the rejection is logged. |
| FR-LRN-03 | **Skill creation:** the bot creates new skills in Agent Skills format (D-22) from a taught workflow ("learn this process"). The skill can be rerun and scheduled as a routine. | Teaching a 5-step process produces a valid `SKILL.md` that `skills-ref validate` accepts and that reruns correctly. |
| FR-LRN-04 | **Usage telemetry** per skill: view, use and patch counts, last-used date. | Counts update on use. |
| FR-LRN-05 | **Curator agent:** runs weekly while idle. Marks skills stale after 30 days unused and archives them after 90 days (configurable). Never deletes. Pinned and locked skills are protected. Keeps a JSONL ledger and a snapshot before each run, with rollback. | Dry-run, run and rollback commands work; nothing is deleted. |
| FR-LRN-06 | Optional LLM consolidation (merging similar skills) is off by default, and its toggle is in Settings. | Off on a fresh install. |

### 5.6 Long-term memory (Obsidian-compatible)
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-MEM-01 | Vault layout: `vault/agents/<bot>/` (private, owner-writes-only), `vault/shared/` (all agents read; writes go through an append-only log with a single writer per file) and `vault/user/` (facts about the owner). | Folder rules are enforced by code. |
| FR-MEM-02 | Notes use YAML frontmatter (`type`, `tags`, `created`, `updated`, `source`) and `[[wikilinks]]`. A `MEMORY.md` index per agent lists one line per note. | Opening the vault in Obsidian shows a valid graph and links. |
| FR-MEM-03 | Retrieval: SQLite FTS5 full-text search plus a frontmatter index, with progressive disclosure (index first, then note bodies on demand). Embeddings are optional (local model) and off by default. | Relevant notes come back in the top 5 in the retrieval test set. |
| FR-MEM-04 | The vault is a git repo, with auto-commits per write batch for history and rollback. | Every change is in git history. |
| FR-MEM-05 | The vault is encrypted at rest (D-15) unless the owner chooses "plain vault for Obsidian" in Settings, which shows a warning. | Default is encrypted; plain mode is opt-in. |

### 5.7 MCP
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-MCP-01 | **MCP client:** Bots use any MCP server, local (stdio, run inside the Bot's container) or remote (Streamable HTTP). | Connects to the reference "everything" server over both transports. |
| FR-MCP-02 | Spec 2026-07-28 support: `server/discover`, per-request `_meta` version and capabilities, the tasks extension, MRTR `input_required`, tools, resources, prompts and elicitation (form and URL mode), with fallback to 2025-11-25 (initialize, sessions). | Conformance tests pass against both spec versions. |
| FR-MCP-03 | **Auth:** OAuth 2.1 with RFC 9728, 8707 and 9207 and Client ID Metadata Documents. No token passthrough. Tokens never go in query strings. Secrets are requested only through URL-mode elicitation. | An auth test against a protected test server passes. |
| FR-MCP-04 | **MCP server:** StellarCortex exposes its own MCP server, so external MCP clients (for example Claude Code on the owner's PC) can message Bots, list routines and read the Library. Owner auth is required. | An external client lists and messages Bots. |
| FR-MCP-05 | MCP management UI: add, remove, enable per Bot, view tools, and set per-server tool allowlists. | All work from Settings. |

### 5.8 Third-party skills
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-SKL-01 | Install skills from a GitHub `owner/repo[/path]`, a skills.sh entry or a local folder. | All three sources install. |
| FR-SKL-02 | Install pipeline: pin to the commit SHA, show the full `SKILL.md` and file list, static scan (scripts, network calls, prompt-injection patterns, secrets access), validate with the Agent Skills spec, then the **owner approves** before activation. Bots cannot install skills on their own initiative. | An unapproved skill never activates; scan findings are shown. |
| FR-SKL-03 | Third-party skill scripts run only inside the Bot's container, without access to server secrets. | A test skill cannot read server secrets. |
| FR-SKL-04 | Update check per installed skill: show the diff of the new SHA; updating requires owner approval. | The diff is shown and nothing auto-updates. |
| FR-SKL-05 | Skills are compatible with Claude Code, Hermes and other Agent-Skills tools (standard fields only). | An exported skill loads in Claude Code. |

### 5.9 Google login and integrations
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-GGL-01 | **Setup wizard** (first run) guides the operator step by step to create a free Google Cloud project, a consent screen (External, Testing), a Web OAuth client (with the redirect URI pre-filled by the wizard) and an Android OAuth client (package + SHA-1 shown by the wizard). The operator pastes the client ID and secret. | A non-technical tester completes the wizard in under 15 min. |
| FR-GGL-02 | **Login:** Sign in with Google on desktop (system browser + PKCE + loopback) and Android (Credential Manager). The server verifies the ID token (JWKS, `iss`, `aud`, `exp`) and keys the account on `sub`. | Login works on all 4 client platforms. |
| FR-GGL-03 | **Allowlist:** the first login becomes owner. The owner can add other Google accounts (each gets their own Bots). Unknown accounts are rejected. | An unlisted account gets 403. |
| FR-GGL-04 | **Auto-connect Google services** right after login, in one consent screen: Gmail (`gmail.modify`, `gmail.send`), Calendar, Drive and Contacts. Refresh tokens are stored encrypted. | All 4 connectors work after one consent. |
| FR-GGL-05 | **7-day expiry handling** (Testing mode): the server tracks token age, notifies on day 6 with a one-tap re-consent, and degrades gracefully (connector shows "reconnect") on expiry. | Simulated expiry shows a reminder and the reconnect flow. |
| FR-GGL-06 | Built-in Google tools for Bots: search, read, label, draft and send mail; read and create calendar events; search, read and upload Drive files; look up contacts. | Each tool passes an integration test against a test account. |
| FR-GGL-07 | Break-glass admin: a local CLI command on the server (`advence admin`) can reset the owner and devices if Google login breaks. | Recovery works without Google. |

### 5.10 Proactive bots
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-PRO-01 | A per-Bot **"Proactive"** toggle, off by default. | Toggle exists; off on new Bots. |
| FR-PRO-02 | Trigger types: **schedule** (cron-like), **new mail** (Gmail push or poll, with filter), **calendar** (event soon), **file or folder watcher** (Drive or bot computer), **webhook**, **MCP notification**, **daily digest**. | Each trigger type fires in a test. |
| FR-PRO-03 | **Full autonomy:** a triggered proactive Bot may take any action its tools allow, including outbound ones (send mail, post, buy through a browser), **with no approval prompt** (D-19). | An end-to-end test: incoming mail triggers a reply that is sent automatically. |
| FR-PRO-04 | **Action suggestions** (Hark-style): proactive Bots also surface ranked suggestion cards ("answer this email", "pay this bill") that run start to finish with one tap. | Cards appear and run. |
| FR-PRO-05 | **Activity log:** every autonomous action is logged with trigger, input summary, action and result, and is visible in the Bot profile and a global feed. | All autonomous actions appear in the log. |
| FR-PRO-06 | **Kill switch:** a global "pause all proactivity" button plus a per-Bot pause, on desktop and Android, effective within 2 s. | Pausing stops queued and running autonomous actions. |
| FR-PRO-07 | Non-proactive Bots keep the old rule: external content (mail, web, MCP, webhooks) is data and never triggers an action. | A prompt-injection test against a non-proactive Bot causes no action. |
| FR-PRO-08 | Notifications: proactive results and suggestions are pushed (D-18). Notifications can be muted per Bot or app-wide. | Push arrives on Android within 10 s. |

### 5.11 Clients and platforms
| ID | Requirement | Acceptance criteria |
|---|---|---|
| FR-CLI-01 | Desktop apps: Windows x64 (NSIS installer), macOS universal (DMG), Linux x64 (AppImage + .deb). | Installers build in CI and launch on each OS. |
| FR-CLI-02 | Android app: APK for Android 9+, arm64 + x86_64. | Installs and runs on a real Android 9+ device and an emulator. |
| FR-CLI-03 | **Server-connection** screen: add a server by scanning a QR (desktop shows the QR, Android scans it) or pasting a pairing link. Saved servers, one active at a time, with a switch button. | Pairing works via QR and via link. |
| FR-CLI-04 | **No browser UI by default.** When enabled (D-16), it uses the same React UI, served with CSP + SRI, behind Google login + device pairing. | Off by default; when on, an unpaired browser cannot get in. |
| FR-CLI-05 | Auto-update per D-24 on all clients and on the server. Every update is signature-checked before it is applied. | A tampered update is rejected. |
| FR-CLI-06 | **Server install** is a one-line installer per OS: `curl … \| sh` (Linux/macOS) and a PowerShell one-liner (Windows). It installs Node runtime, Podman, the service and the image. | Fresh-machine install passes on Ubuntu 24.04+, Windows 11 and macOS 14+. |

---

## 6. Security and encryption (NFR-SEC)

| ID | Requirement | Acceptance criteria |
|---|---|---|
| NFR-SEC-01 | **Transport:** TLS 1.3 only. The server generates its own key at install. Clients **pin** the server public key from the pairing QR or link. There is no CA trust and no plaintext HTTP, except the loopback OAuth redirect. | MITM test with another cert is rejected. |
| NFR-SEC-02 | **Device keys:** each client generates an Ed25519 key pair at pairing. The owner approves new devices by matching a 6-digit code shown on both sides. Every API/WS request is signed by the device key, and the server checks it with nonce + timestamp. Devices can be revoked. | A revoked device is refused immediately. |
| NFR-SEC-03 | **Session:** Google login (who) + device key (which device) are both required. Session tokens are short-lived (15 min) and refresh through device signature. | An expired token or a missing signature is refused. |
| NFR-SEC-04 | **At rest:** API keys, OAuth tokens, the memory vault (FR-MEM-05), chat history and attachments are encrypted with XChaCha20-Poly1305 under a master key. The master key is wrapped by an OS keystore where available and otherwise by a passphrase (Argon2id). | A raw data-folder dump reveals no secrets or content. |
| NFR-SEC-05 | **Key backup:** an encrypted export of the master key + device registry (passphrase, Argon2id), restorable on a new server. | Backup and restore round-trip works. |
| NFR-SEC-06 | **Honest wording:** UI and docs describe the model as "encrypted from your devices to your server; your server runs the bots and can read their content". The product never claims more than this. | Copy review. |
| NFR-SEC-07 | **Client hardening:** Electron with contextIsolation, sandbox, no nodeIntegration, fuses (asar integrity, runAsNode off) and a strict CSP. Capacitor with no remote code loading. The UI is always bundled inside the app, never fetched from the server. | Security checklist test. |
| NFR-SEC-08 | **Container isolation:** rootless, no Podman socket inside containers, no host mounts except the Bot's own volume, a network policy that blocks access to the server's admin API from the container, and seccomp on. | Escape-attempt test suite passes. |
| NFR-SEC-09 | **Secrets in logs:** a redaction filter on all logs and on the activity log. | Seeded secrets never appear in logs. |
| NFR-SEC-10 | **Release signing:** Ed25519 release key. The public key is pinned in each install. The private key never enters the repo or CI logs. | A verify step runs in tests. |
| NFR-SEC-11 | **Prompt-injection rule** (FR-PRO-07) is enforced by **taint propagation** in the runtime: content from external sources is marked tainted, and a tainted instruction cannot trigger tools in non-proactive Bots. It is a hard block, not a prompt-level rule. | An injection test suite passes. |

## 7. Non-functional requirements (other)

| ID | Requirement | Acceptance criteria |
|---|---|---|
| NFR-PERF-01 | First token of a chat reply streams to the UI within 1 s after the model starts sending. | Measured in test. |
| NFR-PERF-02 | The server supports at least 10 Bots with running containers on a 32 GB / 8-core host. | Load test. |
| NFR-REL-01 | The server survives restart: chats, routines, triggers and containers resume. Clients reconnect their event stream automatically, and a silently dead stream is detected by heartbeat within 30 s. | Kill and restart test. |
| NFR-REL-02 | Updates are atomic with automatic rollback when the health check fails. | A failed-update test rolls back. |
| NFR-COST-01 | No paid dependency, service, certificate or store account anywhere (C-04). | A dependency and license audit lists none. |
| NFR-LIC-01 | Every bundled third-party component has a license compatible with private redistribution and is listed in `THIRD_PARTY_NOTICES.md`. GPL components (KasmVNC, Xpra) are **not** used. | License audit. |
| NFR-A11Y-01 | Keyboard navigation and screen-reader labels on all main screens. | Accessibility audit (axe) has no criticals. |

---

## 8. Phases and milestones

Each phase ends with its AC passing, code review (correctness + appsec) and QA. Phases run in order. Within a phase, independent items can run in parallel.

| Phase | Content | Exit criteria |
|---|---|---|
| **P0 Spikes** (throwaway) | (1) Rootless Podman container with Xfce + TigerVNC + noVNC + Chromium (sandbox on): measure latency vs the old VM and check `chrome://sandbox`. (2) The same on Windows Podman machine and macOS Podman machine. (3) Capacitor Android shell loading a Vite React app + UnifiedPush/ntfy delivery over 24 h. (4) Google OIDC + Gmail in Testing mode with the operator's own project. | A written report per spike in `docs/spikes/`. A failure leads to a recorded fallback (for example KasmVNC is NOT allowed by NFR-LIC-01; the fallback is Selkies, MPL-2.0). |
| **P1 Foundation** | Monorepo, server skeleton, protocol package, crypto (NFR-SEC-01..05), Google login + devices (FR-GGL-01..03, 07), React UI shell + i18n/RTL + themes, Electron + Capacitor shells, pairing (FR-CLI-03). | Login + pairing + an empty chat round-trip on desktop and Android. |
| **P2 Bots & chat** | FR-UI-01..04, 07..10, FR-BOT-01..05, model router (D-07), push (D-18), activity log base. | Chat with a Bot on all clients using each model source. |
| **P3 Computer & coding** | FR-PC-01..09, FR-UI-05, FR-CODE-01..05. | Coding benchmark (FR-CODE-03) passes in a container on Linux, Windows and macOS hosts. |
| **P4 Memory, learning, skills** | FR-MEM-*, FR-LRN-*, FR-SKL-*. | Learn-pass and curator tests; third-party install pipeline. |
| **P5 MCP & Google tools** | FR-MCP-*, FR-GGL-04..06. | MCP conformance; Google tools integration tests. |
| **P6 Proactivity** | FR-PRO-*, FR-UI-06, NFR-SEC-11. | Autonomy e2e + kill switch + injection suite. |
| **P7 Hardening & release** | NFR-*, installers (FR-CLI-01, 02, 05, 06), updater (D-24), docs. | Fresh install on 3 OSes + Android; signed release candidate ready. **The owner approves before anything is published (C-07).** |

---

## 9. Out of scope for v1

- iOS / iPadOS clients.
- Google Play, Apple App Store and Microsoft Store distribution, and paid code signing (C-04).
- Public Gmail verification / CASA (C-04).
- Phone-side integrations (Android calendar, contacts, alarms, location).
- Voice chat and voice memos.
- Multiple servers active at the same time in one client, and bot-to-bot bridging across servers.
- Prebuilt marketplace Bots, and an apps/plugins marketplace.
- Hosted / multi-tenant SaaS version.
- gVisor / Kata isolation (possible later hardening).
- Migration of data from the original StellarCortex.

---

## 10. Decision log (owner's words)

| Date | Decision | Owner quote |
|---|---|---|
| 2026-11-07 | New private repo, original untouched | "פרוייקט מקביל … בלי לגעת במקורי"; repo `stellarcortex-advence` (private) |
| 2026-11-07 | Doc must let another agent start with no questions | "שאוכל לתת לסוכן אחר את המשימה ויוכל להתחיל ללא שאלות נוספות" |
| 2026-11-07 | Grok Bot layout, our logo | "לא צריך העתקה מדוייקת אבל פריסה וממשק אפשר כמובן נשתמש בלוגו שלנו" |
| 2026-11-07 | Free only | "כל ההחלטות צריכות להישאר במצב חינמי" |
| 2026-11-07 | Models: all three, user picks | Chosen in decision round |
| 2026-11-07 | Proactivity: full autonomy | Chosen in decision round, over notify-only |
| 2026-11-07 | Rewrite from scratch | Chosen in decision round |
| 2026-11-07 | Browser UI: paired devices, encrypted | Chosen in decision round |

## 11. Original requirement → coverage map

| Owner requirement (summary) | Covered by |
|---|---|
| More like Grok Bot, identical-style interface | C-05, FR-UI-* |
| Coding at Claude Code/Cursor/Codex level, on the bot's computer | D-08, FR-CODE-* |
| Same bot computer, in a container, smooth | D-09, D-10, FR-PC-* |
| Hermes-style self-learning with a curator | D-21, FR-LRN-* |
| New skills and learning processes | FR-LRN-03, FR-SKL-* |
| Obsidian-based long-term memory for all agents | D-20, FR-MEM-* |
| Windows, Linux and macOS support | D-11, FR-PC-07, FR-CLI-06 |
| Desktop apps for all platforms | D-04, FR-CLI-01 |
| Android apps | D-05, FR-CLI-02 |
| Google account login | D-13, FR-GGL-01..03 |
| Automatic Gmail/Google connections | D-14, FR-GGL-04..06 |
| Full MCP support | D-23, FR-MCP-* |
| Full third-party skills support | FR-SKL-* |
| End-to-end encryption on the whole interface | D-15, NFR-SEC-* |
| No browser UI by default; optional encrypted | D-16, FR-CLI-04 |
| Same interface on desktop and Android | D-03, FR-UI-08 |
| Proactivity for some bots, hark-style | D-19, FR-PRO-* |
