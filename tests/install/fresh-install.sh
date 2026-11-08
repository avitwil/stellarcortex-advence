#!/usr/bin/env bash
# Fresh-machine install test for Linux and macOS (FR-CLI-06), plus a signed in-place update
# through the installed service (FR-CLI-05, NFR-REL-02). Used by CI; run from the repository root
# after `pnpm install` as a normal user. It signs with a throwaway key made for this run only,
# never the release key, and serves the feed on loopback.
#   tests/install/fresh-install.sh            full install (Podman and the Bot computer image too)
#   ADVENCE_SKIP_COMPUTER=1 tests/install/fresh-install.sh
set -euo pipefail
WORK=$(mktemp -d)
FEED_DIR="$WORK/feed"
PORT=8899
FEED="http://127.0.0.1:$PORT"
export ADVENCE_SKIP_PAIR=1
STAGE="$WORK/stage"
mkdir -p "$FEED_DIR" "$STAGE"

health() { curl -fsk "https://127.0.0.1:4443/v1/health" 2>/dev/null || true; }
wait_version() {
  for _ in $(seq 1 120); do
    if health | grep -q "\"version\":\"$1\""; then echo "server reports $1"; return 0; fi
    sleep 1
  done
  echo "server did not report $1"; health; return 1
}
publish() { # version; the feed is flat, like a GitHub release
  rm -f "$STAGE"/* "$FEED_DIR"/*.tar.gz "$FEED_DIR"/server-manifest.json*
  node scripts/release/bundle-server.mjs --version "$1" --out "$STAGE" ${SKIP_BUILD:-}
  node scripts/release/manifest.mjs --component server --version "$1" --dir "$STAGE" --out "$STAGE/server-manifest.json"
  node scripts/release/sign.mjs --key-file "$WORK/release.key" "$STAGE/server-manifest.json"
  cp "$STAGE"/* "$FEED_DIR/"
}

node scripts/release/keygen.mjs --out "$WORK/release.key" | tee "$WORK/keygen.txt"
PUB=$(sed -n 's/.*ADVENCE_RELEASE_PUBKEY): //p' "$WORK/keygen.txt")
export ADVENCE_RELEASE_PUBKEY="$PUB" ADVENCE_FEED_URL="$FEED"
publish 0.9.0
SKIP_BUILD=--skip-build
node scripts/release/render-installers.mjs --feed "$FEED" --keys "$PUB" --out "$FEED_DIR"
(cd "$FEED_DIR" && python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &)
for _ in $(seq 1 20); do curl -fs "$FEED/install.sh" -o /dev/null && break; sleep 0.5; done

echo "== a tampered bundle is refused and nothing is installed"
BUNDLE=$(ls "$FEED_DIR"/*.tar.gz)
cp "$BUNDLE" "$WORK/good.tar.gz"
printf 'x' >> "$BUNDLE"
if curl -fsSL "$FEED/install.sh" | sh; then echo "tampered install succeeded"; exit 1; fi
cp "$WORK/good.tar.gz" "$BUNDLE"
test -z "$(health)"

echo "== fresh install"
curl -fsSL "$FEED/install.sh" | sh
wait_version 0.9.0
export PATH="$HOME/.local/bin:$PATH"
advence version

echo "== signed update through the running service"
publish 0.9.1
advence update check | tee "$WORK/check.txt"
grep -q 'Update available: 0.9.1' "$WORK/check.txt"
advence update apply
wait_version 0.9.1

echo "== the installer refuses an older signed release"
publish 0.9.0
if curl -fsSL "$FEED/install.sh" | sh; then echo "downgrade was installed"; exit 1; fi
case "$(uname -s)" in
  Darwin) ROOT="$HOME/Library/Application Support/Advence/server" ;;
  *) ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/advence-server" ;;
esac
[ "$(cat "$ROOT/current")" = 0.9.1 ]

echo "== running the installer again upgrades"
publish 0.9.2
curl -fsSL "$FEED/install.sh" | sh
wait_version 0.9.2
[ "$(cat "$ROOT/current")" = 0.9.2 ]
[ ! -f "$ROOT/pending.json" ]
echo "fresh install and update passed"
