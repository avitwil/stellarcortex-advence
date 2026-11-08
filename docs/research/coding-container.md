# Research: coding engine and per-bot container (stellarcortex-advence)

Date: 2026-11-07. Researcher brief. No code written. Sources checked live today unless marked (secondary) or (unverified).

## Bottom line
- **Coding engine:** Claude Agent SDK, authenticated with an API key only. Add OpenCode (MIT) as the open, provider-agnostic second engine, pointed at local or API models. Use Codex CLI (Apache-2.0) with an API key as a third option. Skip Cursor CLI for v1 (license and billing unclear).
- **Bot computer:** one container per bot, keeping the current desktop stack (Xfce + TigerVNC + noVNC, MPL-2.0). Run rootless Podman on Linux with NVIDIA CDI. Use Podman machine (WSL2) on Windows. On macOS, expect CPU-only. Keep the Chromium sandbox on, run as non-root, and use a narrow seccomp profile. gVisor and Kata are later hardening options, not v1.

## Facts (sourced)

### Coding engines
| Option | License | Auth / ToS | Headless / model | Fit |
|---|---|---|---|---|
| Claude Agent SDK (npm/PyPI) | Proprietary, "All rights reserved" (see memory note; not vendored) | Products must use API key. Third parties may not offer claude.ai login or rate limits "unless previously approved" | Full agent loop, hooks, subagents, sessions; Claude models | Best capability match. Use with API key |
| Claude Code `claude -p` | Proprietary binary | `--bare` never reads subscription OAuth; set `ANTHROPIC_API_KEY` | JSON/stream output; Claude models | Good CLI fallback |
| OpenAI Codex CLI | Apache-2.0 (GitHub API, openai/codex) | Sign-in with ChatGPT or API key. Docs call API key "the recommended default for automation" and warn against untrusted environments | `codex exec`; GPT models | Good second engine, API key mode |
| Cursor CLI (`agent -p`) | Proprietary | `CURSOR_API_KEY` for headless; `--force` to write. Current ToS (last updated 2026-09-03) silent on CLI inside third-party products | Cursor-routed models; billing reports conflict (secondary) | Weakest for v1 |
| OpenCode | MIT (GitHub API, anomalyco/opencode) | Anthropic Pro/Max login removed in v1.3.0 after Anthropic legal request (PR #18186, merged 2026-03-19; reason is secondary). Docs list API keys, any OpenAI-compatible API, Ollama, LM Studio, vLLM | Model-agnostic | Best open fit, also covers the home llama.cpp server |

- Anthropic's rule, restated on the Agent SDK overview and quickstart pages: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products." (code.claude.com/docs/en/agent-sdk/overview.md; quickstart.md)
- Hosting clause, legal-and-compliance page: running Claude Code "in hosted sandboxes or other agent infrastructure" needs a Commercial Terms agreement. The binary must be unmodified, and each end user uses their own API key or subscription. Usage cannot be resold or intermediated.
- Managed Agents (Anthropic-hosted, or self-hosted sandbox) exists as a third option. Terms not checked (unverified).

### Container stack
- KasmVNC: GPL-2.0 (GitHub API, LICENSE.TXT). Some images are GPL-3.0 at base (secondary).
- noVNC: MPL-2.0 (LICENSE.txt). Already vendored by StellarCortex at 1.6.0 (THIRD_PARTY_NOTICES.md).
- Selkies: MPL-2.0 (LICENSE). WebSocket by default, WebRTC opt-in. README says it "is in need of maintainers" (maintenance risk).
- Xpra: GPL-2.0 (COPYING, no "or later" confirmed).
- Chromium: Docker docs for Chrome say run the sandbox. `--no-sandbox` is "strongly discouraged". Recommended path is non-root user; `--cap-add=SYS_ADMIN` is for debugging only (pptr.dev troubleshooting).
- Docker default seccomp blocks `clone` and `unshare` namespace creation; the exception is `CLONE_NEWUSER`/`unshare --user`. `seccomp=unconfined` removes the filter entirely (docs.docker.com seccomp page).
- gVisor nvproxy: officially supported GPUs are T4, A100, A10G, L4, H100. `graphics` and `video` capabilities are off by default and widen the host surface. X11 or display support is not documented (gvisor.dev GPU page).
- Kata GPU docs: 404 on the URL tried. Not verified.
- Docker Desktop GPU: supported on Windows WSL2 with NVIDIA only (`--gpus`). Linux and macOS not covered by the page (docs.docker.com/desktop/features/gpu).
- Podman GPU: Windows WSL2 needs NVIDIA Pascal or later and CDI; Linux needs nvidia-container-toolkit and CDI; macOS uses a libkrun virtual GPU for Vulkan compute only, with no NVIDIA passthrough documented (podman-desktop.io GPU page, docs.podman.io podman-machine).
- Apple `container`: Apple silicon and macOS 26 required (README via GitHub API). GPU not mentioned. Apache-2.0 only from metadata (secondary).
- WSL2: runs distros in a utility VM, supports GPU compute, WSLg for GUI apps (learn.microsoft.com WSL about, updated 2026-06-02).

### Licensing: Docker Desktop
- Free only for "Small businesses (fewer than 250 employees AND less than $10 million in annual revenue)" (docs.docker.com/subscription/desktop-license). Press reports say "OR"; the primary says AND. Contractor counting is not on the page (FAQ page did not answer). Paid tiers: Pro, Team, Business. Price from ~$5/user/month (secondary, verify on pricing page).

### Existing StellarCortex facts (from code, not web)
- Desktop stack today: TigerVNC, Xfce, noVNC 1.6.0 (THIRD_PARTY_NOTICES.md).
- `docker compose exec stellarcortex` already appears in `src/claude-login.mjs`, so a container path partly exists. `computer-mode.mjs` only detects `/.dockerenv`.
- `claude-login.mjs` routes the owner's `claude` sign-in. Under the rules above this is a gray zone for a multi-bot product that serves others.

## Options and recommendation per item

### 1. Coding engine
| Option | Pros | Cons | Fit |
|---|---|---|---|
| Agent SDK + API key | Same loop as Claude Code; hooks, sessions, subagents | Per-token cost; proprietary; no subscription use | **Recommended primary** |
| OpenCode + API / local models | MIT; many providers; local models | Less Claude-tuned; no Anthropic subscription | **Recommended second** |
| Codex CLI + API key | Apache-2.0; strong; official automation guidance | GPT only; ChatGPT login ToS for products unverified | Third option |
| Cursor CLI | Usable headless | ToS silent on products; billing unclear | Defer |
| Claude subscription login inside the product | Lower cost for owner | Forbidden for product offered to others; gray zone even for owner | **Do not ship** |

### 2. Container per bot
| Choice | Pros | Cons | Fit |
|---|---|---|---|
| Xfce + TigerVNC + noVNC (current) | Matches today's VM; MPL-2.0 | Less smooth than WebRTC | **Recommended v1** |
| KasmVNC | Smoother; GPU DRI3 | GPL-2.0 (copyleft review); privileged-ish setup | Option if noVNC is too slow |
| Selkies | WebRTC-capable | Maintainers wanted | Watch |
| Rootless Podman (Linux) | No root daemon; CDI GPU | Less familiar than Docker | **Recommended Linux runtime** |
| Docker Engine (Linux) | Familiar | Root daemon unless rootless | Acceptable |
| gVisor / Kata | Stronger isolation | GPU limits; display unverified; heavier | Later, for hostile-page bots |
| Docker Desktop (Windows/macOS) | Easy | Paid above 250 staff or $10M revenue | Use only if licensed |
| Podman machine (Windows WSL2) | No Docker Desktop license | Setup effort; NVIDIA only for GPU | **Recommended Windows path** |
| macOS (Podman libkrun or Apple `container`) | Runs | No NVIDIA; CPU-only desktop | Accept CPU-only |

## Risks and unknowns
- The Chromium sandbox inside a container is not fully verified here. Test `chrome://sandbox` in the chosen runtime before committing.
- The seccomp profile needed for Chromium user namespaces is not verified. Do not assume `unconfined` is acceptable.
- The OpenCode Anthropic removal reason is from secondary sources. The docs page has no date.
- Codex ChatGPT-login terms for third-party products are not confirmed.
- Docker Desktop contractor counting is not confirmed.
- Kata GPU docs were not reached.
- Podman and Apple `container` license text not read directly.
- Legal question for the owner: whether the product will be offered to others (hosting clause).

## Ask
1. Confirm the product will not offer Claude login to others. Then the Agent SDK with API key is the engine.
2. Decide whether to keep noVNC or move to KasmVNC (GPL-2.0) after a latency test.
3. Cheapest validation: a spike with one Podman rootless container (Xfce + TigerVNC + noVNC + Chromium with sandbox on, non-root) on Linux, measuring latency and `chrome://sandbox`.

## Sources
- https://code.claude.com/docs/en/legal-and-compliance.md
- https://code.claude.com/docs/en/agent-sdk/overview.md
- https://code.claude.com/docs/en/agent-sdk/quickstart.md
- https://code.claude.com/docs/en/headless.md
- https://learn.chatgpt.com/docs/auth
- https://api.github.com/repos/openai/codex/license (Apache-2.0)
- https://cursor.com/docs/cli/headless
- https://cursor.com/terms-of-service (last updated 2026-09-03)
- https://opencode.ai/docs/providers/
- https://api.github.com/repos/anomalyco/opencode/license (MIT)
- https://github.com/anomalyco/opencode/pull/18186 (secondary via search)
- https://docs.docker.com/subscription/desktop-license/
- https://api.github.com/repos/kasmtech/KasmVNC/license (GPL-2.0)
- https://github.com/novnc/noVNC/blob/master/LICENSE.txt (MPL-2.0)
- https://github.com/selkies-project/selkies/blob/main/LICENSE (MPL-2.0)
- https://github.com/Xpra-org/xpra/blob/master/COPYING (GPL-2.0)
- https://pptr.dev/troubleshooting
- https://docs.docker.com/engine/security/seccomp/
- https://gvisor.dev/docs/user_guide/gpu/
- https://docs.docker.com/desktop/features/gpu/
- https://podman-desktop.io/docs/podman/gpu
- https://docs.podman.io/en/latest/markdown/podman-machine.1.html
- https://api.github.com/repos/apple/container/readme
- https://learn.microsoft.com/en-us/windows/wsl/about
