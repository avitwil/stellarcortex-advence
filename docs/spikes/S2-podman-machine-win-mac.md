# Spike S2: Podman machine on Windows (WSL2) and macOS

Phase: P0. Requirement refs: D-10, D-11, FR-PC-07, FR-PC-08.

## Status
**Not runnable in this environment** (Linux cloud container, no Windows or macOS host,
no nested virtualization). Recorded as manual checks MC-S2-WIN and MC-S2-MAC in
`docs/manual-checks.md`, with exact steps. Not marked as passed.

## Design that the spike validates
- Windows 10/11: `podman machine init --rootful=false --cpus 4 --memory 8192` on the
  WSL2 provider, then `podman machine start`. The server talks to the machine through
  the Podman API exposed on the Windows named pipe (`podman machine inspect` gives the
  pipe path). GPU: NVIDIA Pascal+ with CDI inside the machine (`nvidia-ctk cdi generate`),
  passed with `--device nvidia.com/gpu=all`.
- macOS 14+: `podman machine init` (applehv/libkrun provider), CPU only. The image is
  built for the host arch (arm64 on Apple silicon), so the Containerfile uses only
  multi-arch Ubuntu and Debian packages.
- The same `images/bot-computer` Containerfile is used on all three OSes.

## Fallbacks if a check fails
- If Chromium's namespace sandbox fails inside the Podman machine VM, fall back to the
  setuid `chromium-sandbox` helper (installed with the Debian package). Never
  `--no-sandbox`.
- If noVNC latency is too high on the macOS machine, the fallback is Selkies (MPL-2.0),
  per the spec. KasmVNC is not allowed.
