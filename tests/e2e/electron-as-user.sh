#!/bin/sh
# Test-only wrapper: Chromium refuses to run its sandbox as root, and the app always
# enables the sandbox, so when the test container runs as root we drop to an unprivileged
# user. On CI runners (non-root) the wrapper is not used.
exec setpriv --reuid="${E2E_UID}" --regid="${E2E_GID}" --clear-groups -- "$(dirname "$0")/../../apps/desktop/node_modules/electron/dist/electron" "$@"
