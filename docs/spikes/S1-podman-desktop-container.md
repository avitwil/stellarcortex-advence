# Spike S1: rootless Podman bot computer (Linux)

Phase: P0. Requirement refs: D-09, D-10, FR-PC-01, FR-PC-02, FR-PC-04, FR-PC-05.

## Goal
Run Xfce + TigerVNC + noVNC + Chromium (sandbox on) in a Podman container, check
`chrome://sandbox`, and measure desktop latency against the old VM.

## What ran here (Linux x64, Ubuntu 24.04 host, Podman 4.9.3, 4 vCPU, no KVM)
| Check | Result |
|---|---|
| Image `images/bot-computer` (Ubuntu 26.04.1 base, Xfce 4.20, TigerVNC 1.15, noVNC 1.6, websockify 0.13) builds | **Pass**, 2 min 15 s cold, 1.31 GB |
| Container starts as non-root user `bot` (uid 1000); every process in the container runs as `bot` | **Pass** |
| VNC refuses to start without an injected password secret | **Pass** (exit 64) |
| noVNC served on the published loopback port, RFB VncAuth connect | **Pass** |
| `chrome://sandbox` in a **rootful** container, default Podman seccomp, non-root user | **Pass**: "Layer 1 Sandbox: Namespace; PID/Network namespaces: Yes; Seccomp-BPF: Yes, TSYNC: Yes. You are adequately sandboxed." |
| Same in a **rootless** container (uid map 0->999, 1->200000..) | **Pass**, same output |
| Memory limit (`--memory 2g`) visible in the container cgroup | **Pass** (2147483648) |
| Input-to-screen latency, noVNC client to container on loopback, key press into Chromium omnibox, 25 samples | p50 **40.5 ms**, p95 124 ms, max 124 ms |

No `--no-sandbox`, no `--cap-add`, no `seccomp=unconfined` was used.

## Findings and decisions
- Ubuntu 26.04 ships Chromium only as a snap, which cannot run inside a container.
  **Decision:** install Chromium from Debian stable + Debian security with apt pinning,
  so only the Chromium packages come from Debian (`images/bot-computer/debian-chromium.sh`).
  This sandbox host blocks `deb.debian.org`, so the Debian Chromium layer was not built
  here; the test above bind-mounted an upstream Chromium build instead. CI builds the
  full image (it has normal network access). Recorded in `docs/decisions.md`.
- Rootless networking here needs `/dev/net/tun` (slirp4netns/pasta). This sandbox lacks
  it, so the rootless run used host networking. Normal Linux hosts have it.
- KasmVNC and Xpra are not used (GPL, NFR-LIC-01). TigerVNC runs as a separate process
  (GPL-2.0 program, not linked or redistributed by us: it is installed from Ubuntu at
  image build time on the operator's machine). noVNC is MPL-2.0. The Selkies fallback
  (MPL-2.0) is not needed: TigerVNC + noVNC meets the target here.

## Pending manual check
- Side-by-side latency against the old StellarCortex VM on LAN (FR-PC-02): see
  `docs/manual-checks.md` item MC-PC-02.
