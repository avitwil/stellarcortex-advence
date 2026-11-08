#!/bin/sh
# StellarCortex Advence server installer for Linux and macOS (FR-CLI-06, D-24).
#   curl -fsSL https://<your feed>/install.sh | sh
# It installs, as the current user and without root:
#   - the Node.js runtime from nodejs.org, checked against nodejs.org's SHA-256 list
#   - the server bundle from the update feed, checked against the release key pinned below
#   - a service that starts at boot (systemd user unit with lingering, or a launchd agent)
#   - the `advence` command in ~/.local/bin
# then sets up Podman and the Bot computer image (`advence computer setup`) and shows the
# pairing QR code for your first device. Running it again upgrades in place.
# Environment: ADVENCE_SKIP_COMPUTER=1 skips Podman, ADVENCE_SKIP_SERVICE=1 skips the service,
# ADVENCE_SKIP_PAIR=1 skips pairing; ADVENCE_PORT sets the port.
set -eu

FEED='@FEED_URL@'
RELEASE_KEYS='@RELEASE_KEYS@'

say() { printf '%s\n' "$*"; }
die() { printf 'advence install: %s\n' "$*" >&2; exit 1; }

case "$FEED" in @*) die "this installer was not prepared by the release build (no feed URL)";; esac
case "$RELEASE_KEYS" in @*|'') die "this installer has no pinned release key";; esac
case "$FEED" in
  https://*) ;;
  http://127.0.0.1*|http://localhost*) ;;  # a local mirror (CI)
  *) die "the feed must use https";;
esac
[ "$(id -u)" = 0 ] && die "run this as the user who will own the server, not as root (rootless Podman)"
command -v curl >/dev/null || die "curl is required"
command -v tar >/dev/null || die "tar is required"

case "$(uname -s)" in
  Linux) OS=linux; ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/advence-server" ;;
  Darwin) OS=darwin; ROOT="$HOME/Library/Application Support/Advence/server" ;;
  *) die "unsupported system $(uname -s); on Windows use install.ps1" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported CPU $(uname -m)" ;;
esac
BIN="$HOME/.local/bin"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
fetch() { curl -fsSL --proto '=https,http' --retry 3 -o "$2" "$1"; }

say "StellarCortex Advence: installing into $ROOT"
mkdir -p "$ROOT/versions" "$BIN"
chmod 700 "$ROOT"

# 1. Manifest. Not trusted yet: it only names the Node.js release to fetch, and Node.js itself
#    is checked against nodejs.org. The signature is checked with that Node.js in step 3.
fetch "$FEED/server/manifest.json" "$TMP/manifest.json"
fetch "$FEED/server/manifest.json.sig" "$TMP/manifest.json.sig"
NODE_VERSION=$(sed -n 's/.*"runtime": *"\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' "$TMP/manifest.json" | head -n 1)
[ -n "$NODE_VERSION" ] || die "the release manifest names no Node.js runtime"

# 2. Node.js runtime.
NODE_DIR="$ROOT/node"
if [ ! -x "$NODE_DIR/bin/node" ] || [ "$("$NODE_DIR/bin/node" -v)" != "$NODE_VERSION" ]; then
  NAME="node-$NODE_VERSION-$OS-$ARCH"
  EXT=tar.gz
  say "Downloading Node.js $NODE_VERSION"
  fetch "https://nodejs.org/dist/$NODE_VERSION/$NAME.$EXT" "$TMP/$NAME.$EXT"
  fetch "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" "$TMP/SHASUMS256.txt"
  WANT=$(awk -v f="$NAME.$EXT" '$2 == f { print $1 }' "$TMP/SHASUMS256.txt")
  if command -v sha256sum >/dev/null; then GOT=$(sha256sum "$TMP/$NAME.$EXT" | awk '{print $1}'); else GOT=$(shasum -a 256 "$TMP/$NAME.$EXT" | awk '{print $1}'); fi
  [ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || die "Node.js download does not match nodejs.org's checksum"
  rm -rf "$NODE_DIR.new"
  mkdir -p "$NODE_DIR.new"
  tar -xzf "$TMP/$NAME.$EXT" -C "$NODE_DIR.new" --strip-components 1
  rm -rf "$NODE_DIR"
  mv "$NODE_DIR.new" "$NODE_DIR"
fi
NODE="$NODE_DIR/bin/node"

# 3. Verify the manifest signature against the pinned key, pick this machine's bundle, download
#    it and check its SHA-256 and size. Same format as packages/protocol/src/release.ts.
cat > "$TMP/verify.cjs" <<'EOF'
const fs = require('node:fs'), crypto = require('node:crypto');
const [, , dir, keys, platform, arch, feed] = process.argv;
const manifest = fs.readFileSync(`${dir}/manifest.json`);
const sig = Buffer.from(fs.readFileSync(`${dir}/manifest.json.sig`, 'utf8').trim(), 'base64url');
const msg = Buffer.concat([Buffer.from('stellarcortex-advence release v1\n'), manifest]);
const spki = (k) => crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(k, 'base64url')]), format: 'der', type: 'spki' });
const ok = keys.split(',').filter(Boolean).some((k) => { try { return crypto.verify(null, msg, spki(k), sig); } catch { return false; } });
if (!ok) { console.error('the release manifest signature is not valid for the pinned key'); process.exit(3); }
const m = JSON.parse(manifest);
if (m.product !== 'stellarcortex-advence' || m.component !== 'server') { console.error('not a server release'); process.exit(3); }
const f = m.files.find((x) => x.platform === platform && x.arch === arch);
if (!f || !/^[A-Za-z0-9._-]+$/.test(f.name)) { console.error(`no ${platform}-${arch} bundle in ${m.version}`); process.exit(3); }
if (process.argv[7] === 'check') {
  const data = fs.readFileSync(`${dir}/bundle.tar.gz`);
  if (data.length !== f.size || crypto.createHash('sha256').update(data).digest('hex') !== f.sha256) { console.error('the server bundle does not match the signed manifest'); process.exit(3); }
  process.stdout.write(m.version);
} else process.stdout.write(`${feed}/server/${encodeURIComponent(f.name)}`);
EOF
URL=$("$NODE" "$TMP/verify.cjs" "$TMP" "$RELEASE_KEYS" "$OS" "$ARCH" "$FEED") || die "verification failed; nothing was installed"
say "Downloading the server bundle"
fetch "$URL" "$TMP/bundle.tar.gz"
VERSION=$("$NODE" "$TMP/verify.cjs" "$TMP" "$RELEASE_KEYS" "$OS" "$ARCH" "$FEED" check) || die "verification failed; nothing was installed"
say "Verified release $VERSION"

# 4. Extract next to any version already installed.
rm -rf "$ROOT/versions/.staging"
mkdir -p "$ROOT/versions/.staging"
tar -xzf "$TMP/bundle.tar.gz" -C "$ROOT/versions/.staging"
[ -f "$ROOT/versions/.staging/server/dist/main.js" ] || die "the bundle has no server"

stop_service() {
  if [ "$OS" = linux ] && command -v systemctl >/dev/null; then systemctl --user stop advence.service 2>/dev/null || true; fi
  if [ "$OS" = darwin ]; then launchctl bootout "gui/$(id -u)/com.stellarcortex.advence.server" 2>/dev/null || true; fi
}
[ "${ADVENCE_SKIP_SERVICE:-}" = 1 ] || stop_service
rm -rf "$ROOT/versions/$VERSION"
mv "$ROOT/versions/.staging" "$ROOT/versions/$VERSION"
printf '%s\n' "$VERSION" > "$ROOT/current.tmp" && mv "$ROOT/current.tmp" "$ROOT/current"
cp "$ROOT/versions/$VERSION/launcher.mjs" "$ROOT/launcher.mjs"
rm -f "$ROOT/pending.json"

# 5. The `advence` command.
cat > "$BIN/advence" <<EOF
#!/bin/sh
R='$ROOT'
V=\$(cat "\$R/current")
ADVENCE_INSTALL_ROOT="\$R" exec "\$R/node/bin/node" "\$R/versions/\$V/server/dist/main.js" "\$@"
EOF
chmod 755 "$BIN/advence"
case ":$PATH:" in *":$BIN:"*) ;; *) say "Add $BIN to your PATH to use the advence command."; PATH="$BIN:$PATH" ;; esac

# 6. Service.
PORT_ENV=""
[ -n "${ADVENCE_PORT:-}" ] && PORT_ENV="$ADVENCE_PORT"
if [ "${ADVENCE_SKIP_SERVICE:-}" != 1 ]; then
  if [ "$OS" = linux ]; then
    UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    mkdir -p "$UNIT_DIR"
    {
      echo "[Unit]"
      echo "Description=StellarCortex Advence server"
      echo "After=network-online.target"
      echo "[Service]"
      echo "ExecStart=\"$NODE\" \"$ROOT/launcher.mjs\""
      [ -n "$PORT_ENV" ] && echo "Environment=ADVENCE_PORT=$PORT_ENV"
      echo "Restart=on-failure"
      echo "RestartSec=5"
      echo "[Install]"
      echo "WantedBy=default.target"
    } > "$UNIT_DIR/advence.service"
    # Lingering starts the user's services at boot, before anyone signs in.
    if command -v loginctl >/dev/null && ! loginctl show-user "$(id -un)" --property=Linger 2>/dev/null | grep -q yes; then
      say "Letting the server start at boot (needs sudo once):"
      sudo loginctl enable-linger "$(id -un)" || say "Could not turn on lingering; the server starts when you sign in."
    fi
    systemctl --user daemon-reload
    systemctl --user enable --now advence.service
  else
    PLIST="$HOME/Library/LaunchAgents/com.stellarcortex.advence.server.plist"
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.stellarcortex.advence.server</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$ROOT/launcher.mjs</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>${PORT_ENV:+<key>ADVENCE_PORT</key><string>$PORT_ENV</string>}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/advence-server.log</string>
</dict></plist>
EOF
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
  fi
  say "Waiting for the server to start"
  i=0
  until curl -fsk "https://127.0.0.1:${ADVENCE_PORT:-4443}/v1/health" >/dev/null 2>&1; do
    i=$((i + 1))
    [ $i -gt 60 ] && die "the server did not start; see the service log"
    sleep 1
  done
  say "Server $VERSION is running."
fi

# 7. Bot computers: Podman and the image (FR-PC-07).
if [ "${ADVENCE_SKIP_COMPUTER:-}" != 1 ]; then
  "$BIN/advence" computer setup --yes || say "Bot computers are not ready yet; run 'advence computer setup' later."
fi

# 8. First device.
if [ "${ADVENCE_SKIP_PAIR:-}" != 1 ] && [ -t 1 ] && [ -r /dev/tty ]; then
  "$BIN/advence" pair < /dev/tty || true
else
  say "Pair your first device with: advence pair"
fi
say "Done."
