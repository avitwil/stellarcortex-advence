#!/bin/bash
# Installs the coding engines into the bot's persistent home volume from their official
# registries (C-06, D-08). Run by the server on first start and on engine update.
set -euo pipefail
PREFIX="$HOME/.local"
mkdir -p "$PREFIX"
npm config set prefix "$PREFIX" >/dev/null
for pkg in "$@"; do
  case "$pkg" in
    @anthropic-ai/claude-agent-sdk|@anthropic-ai/claude-code|@openai/codex|opencode-ai) ;;
    *) echo "install-engines: refusing unknown package $pkg" >&2; exit 64 ;;
  esac
  npm install -g --no-fund --no-audit "$pkg"
done
