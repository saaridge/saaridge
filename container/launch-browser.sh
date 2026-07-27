#!/usr/bin/env bash
# Launch Chromium through the bridge proxy (desktop icon / menu).
set -euo pipefail

export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/home/browser}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-browser}"
export PULSE_RUNTIME_PATH="${PULSE_RUNTIME_PATH:-$XDG_RUNTIME_DIR/pulse}"
if [[ -S "${PULSE_RUNTIME_PATH}/native" ]]; then
  export PULSE_SERVER="unix:${PULSE_RUNTIME_PATH}/native"
fi
CRED_FILE="${BRIDGE_CREDENTIALS_FILE:-$HOME/.bridge-credentials}"

if [[ ! -f "$CRED_FILE" ]]; then
  zenity --error --text="Browser is not ready yet. Open OneBridge and click Start workspace." 2>/dev/null \
    || xmessage "Browser is not ready yet. Start the workspace from OneBridge." 2>/dev/null \
    || true
  exit 1
fi

PORT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["localProxyPort"])' "$CRED_FILE")"
PROXY="http://127.0.0.1:${PORT}"
URL="${1:-https://www.google.com}"

# Wait briefly if auth-proxy is still coming up
for _ in $(seq 1 15); do
  if ss -lnt 2>/dev/null | grep -q ":${PORT} "; then
    break
  fi
  sleep 0.3
done

exec /usr/lib/chromium/chromium \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --window-size=1280,800 \
  --window-position=40,40 \
  --start-maximized \
  --disable-features=TouchpadOverscrollHistoryNavigation \
  --use-system-ca-store \
  --proxy-server="$PROXY" \
  --proxy-bypass-list="<-loopback>;host.docker.internal" \
  --user-data-dir="$HOME/chromium-bridge-profile" \
  "$URL"
