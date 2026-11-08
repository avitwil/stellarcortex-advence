# StellarCortex Advence: server admin guide

For the owner who runs the server. The user guide (`docs/user-guide.md`) covers the apps.

## What the server is

One process that holds your Bots, chats, memory, routines and connections, and runs one
container ("Bot computer") per Bot with Podman. Clients reach it on one HTTPS port (default
**4443**) with a self-signed certificate that they pin when you pair them. Everything is
encrypted from your devices to your server; your server runs the Bots and can read their content.

## Requirements

- Ubuntu 24.04 or newer (or another systemd Linux), Windows 11, or macOS 14 or newer.
- A normal user account (not root). Bot computers use rootless Podman.
- For 10 Bots with running computers: 32 GB RAM and 8 cores. Each computer gets 2 CPUs, 3 GB RAM
  and 20 GB disk by default (Settings → Cloud computer).
- Windows: WSL2 (the installer's Podman step sets up a Podman machine). macOS: the Podman machine
  runs without GPU.

## Install

Your release feed serves the installers (see `docs/release.md`).

Linux and macOS:

```sh
curl -fsSL https://updates.example.org/install.sh | sh
```

Windows (PowerShell, as your normal user):

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://updates.example.org/install.ps1 | iex"
```

The installer:

1. downloads Node.js from nodejs.org and checks it against nodejs.org's SHA-256 list;
2. downloads the server bundle and checks its manifest signature against the release key built
   into the installer, then the bundle's SHA-256 and size; it stops and installs nothing when
   either check fails;
3. installs a service that starts at boot: a systemd user unit with lingering on Linux (it asks
   for `sudo` once to turn lingering on), a launchd agent on macOS, a scheduled task at sign-in
   on Windows;
4. adds the `advence` command (`~/.local/bin` on Linux and macOS, `%LOCALAPPDATA%\Advence\bin`
   on Windows);
5. runs `advence computer setup --yes`: installs Podman from your OS packages (apt, dnf, zypper,
   pacman, Homebrew or winget), sets up rootless mode and builds the Bot computer image locally;
6. shows a QR code to pair your first device.

Run it again to repair or upgrade. An upgrade of a running server goes through the same health
check and rollback as an update from the app; an older release is refused unless you set
`ADVENCE_ALLOW_DOWNGRADE=1`. Options: `ADVENCE_PORT=5443` for another port,
`ADVENCE_SKIP_COMPUTER=1` to set up Podman later, `ADVENCE_SKIP_PAIR=1`.

Windows asks whether Node.js may accept connections the first time; allow private networks so
your devices on the LAN can connect.

## First run

1. Pair your first device: scan the QR code from the installer (or run `advence pair`) with the
   app, then type the 6-digit code the app shows into the terminal.
2. The app opens the setup wizard. It walks you through a free Google Cloud project in Testing
   mode, the consent screen, a Web OAuth client (the redirect address is shown for copying) and
   an Android OAuth client (package name and SHA-1 shown). Paste the client ID and secret.
3. Sign in with Google. The first account becomes the owner.
4. Add other people in **Settings → Users** by their Google address. They pair their own devices;
   you approve each new device by typing its code on one of your devices.

## Where things are

| | Linux | macOS | Windows |
|---|---|---|---|
| Program | `~/.local/share/advence-server` | `~/Library/Application Support/Advence/server` | `%LOCALAPPDATA%\Advence\server` |
| Data | `~/.local/share/advence` | `~/Library/Application Support/Advence/data` | `%LOCALAPPDATA%\Advence\data` |
| Unlock file | `~/.config/advence-unlock` | `~/Library/Preferences/Advence/unlock` | `%APPDATA%\Advence\unlock` |
| Log | `journalctl --user -u advence` | `~/Library/Logs/advence-server.log` | Task Scheduler history |

The master key is kept in the OS keystore when there is one (Windows DPAPI, macOS Keychain, Linux
Secret Service). On a headless Linux server it is wrapped with a random passphrase kept in the
unlock folder, outside the data folder.

## Service

- Linux: `systemctl --user status|restart|stop advence`
- macOS: `launchctl kickstart -k gui/$(id -u)/com.stellarcortex.advence.server`, stop with
  `launchctl bootout gui/$(id -u)/com.stellarcortex.advence.server`
- Windows: Task Scheduler, task **StellarCortex Advence server** (`Start-ScheduledTask` /
  `Stop-ScheduledTask`)

## Commands

```
advence pair                 pair a new device (QR code)
advence admin devices        list devices
advence admin revoke <id>    revoke a device
advence admin reset          break-glass: reset the owner and revoke all devices
advence backup --out <file>  encrypted backup of the master key and device registry
advence restore --in <file>  restore a key backup into an empty data folder
advence unlock               type the unlock passphrase
advence computer setup       set up Podman and build the Bot computer image
advence update check         look for a signed update
advence update apply         download, verify and install it (the service restarts into it)
advence version
```

## Backups

Back up the data folder with the service stopped (it holds the encrypted database, vault and
TLS identity), and keep `advence backup --out` with a strong passphrase somewhere else: without
the master key the data folder cannot be read.

## Updates

The server checks your feed daily. **Settings → Updates** (owner) shows a new version with its
notes; **Install and restart** downloads it, checks the signature and the hash, and restarts.
The new version must report healthy within two minutes; otherwise the service goes back to the
previous version and restores the database from the copy made just before the switch, and the
Updates page says so. The previous version stays on disk. An update that needs a newer Node.js
asks you to run the installer again.

## Reaching the server from outside

The server listens on one port. Pick one:

- **LAN only**: nothing to do.
- **Router port forward** of TCP 4443 to the server. Devices still pin the certificate, so a
  forward does not weaken the TLS check. It does make the port reachable from the internet, where
  every request still needs a paired device's signature and a Google sign-in.
- **Tailscale** (free personal plan): install it on the server and your devices and pair using
  the server's Tailscale name, for example `advence pair --host my-server.tailnet.ts.net:4443`.
- **Cloudflare Tunnel** (free Zero Trust plan, up to 50 users): use it as a *private network*
  (cloudflared on the server routing its address, the Cloudflare WARP app on each device), and
  pair with the server's private address. Do not publish the server as a public hostname: that
  ends TLS at Cloudflare, the apps then see Cloudflare's certificate instead of the pinned one and
  refuse to connect (which is the pin doing its job).

The product works without any of them.

## Push notifications (Android)

Android notifications go through UnifiedPush with an ntfy server you control. Run ntfy
(`ntfy serve`, free) on the server or anywhere, set its address in **Settings → Notifications**
(owner), and install the ntfy app on the phone as the distributor. Notifications carry only an id;
the app fetches the content over the pinned connection.

## Browser UI

Off by default. **Settings → Browser UI** turns it on; a browser then needs Google sign-in and a
device approval like any app.

## Uninstall

Stop the service, remove the program folder and the service file
(`~/.config/systemd/user/advence.service`,
`~/Library/LaunchAgents/com.stellarcortex.advence.server.plist`, or the scheduled task), and the
`advence` command. Remove the data and unlock folders only if you want to delete everything.
Bot computers are Podman containers named `advence-bot-*` with volumes of the same names.

## Troubleshooting

- **The installer says verification failed**: the feed served files that do not match the
  signed release. Nothing was installed. Check the feed upload (`docs/release.md`, step 4).
- **Bot computers are unavailable**: run `advence computer setup` and follow what it prints;
  Settings → Cloud computer shows the runtime and image state.
- **Lost all devices**: on the server run `advence admin reset`, then `advence pair`.
