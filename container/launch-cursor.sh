#!/usr/bin/env bash
# Launch Cursor with bridge proxy + MITM CA env (desktop .desktop files omit env).
set -euo pipefail

export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/home/browser}"

if [[ -f /opt/bridge/agent-env.sh ]]; then
  # shellcheck source=/dev/null
  source /opt/bridge/agent-env.sh
fi

CA="${NODE_EXTRA_CA_CERTS:-/opt/bridge/certs/onebridge-mitm-ca.crt}"
export NODE_EXTRA_CA_CERTS="$CA"
export SSL_CERT_FILE="${SSL_CERT_FILE:-$CA}"
export REQUESTS_CA_BUNDLE="${REQUESTS_CA_BUNDLE:-$CA}"

# Electron Chromium network stack: prefer system trust (includes OneBridge MITM CA).
EXTRA_FLAGS=(--no-sandbox --disable-gpu --disable-dev-shm-usage --use-system-ca-store)

PROJECT="${1:-${CURSOR_PROJECT_DIR:-${ONEBRIDGE_PROJECTS:-/host/workspaces/workspace-desktop}}}"
shift || true

exec /usr/share/cursor/cursor "${EXTRA_FLAGS[@]}" "$PROJECT" "$@"
