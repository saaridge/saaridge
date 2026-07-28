#!/bin/bash
# Launch OneBridge into the interactive macOS GUI session.
# 1) Require Docker (prompt if missing; start daemon if stopped)
# 2) Ensure the host control plane (:3847) is up
# 3) Start Electron
# (Background launches from Cursor/IDE often start Electron with no visible window.)
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
ELECTRON_BIN="$DIR/node_modules/.bin/electron"
ELECTRON_APP="$DIR/node_modules/electron/dist/Electron.app"
CONTROL_URL="${ONEBRIDGE_CONTROL_URL:-http://127.0.0.1:3847}"
HOST_LOG="${ONEBRIDGE_HOST_LOG:-/tmp/onebridge-host.log}"
SUPERVISOR_LOG="${ONEBRIDGE_SUPERVISOR_LOG:-/tmp/onebridge-host-supervisor.log}"

export ELECTRON_RUN_AS_NODE=
unset ELECTRON_RUN_AS_NODE

# shellcheck source=../scripts/ensure-docker.sh
source "$ROOT/scripts/ensure-docker.sh"
ensure_docker

control_plane_ok() {
  curl -sf --connect-timeout 1 --max-time 2 \
    "${CONTROL_URL}/api/health" >/dev/null 2>&1
}

ensure_control_plane() {
  if control_plane_ok; then
    echo "[onebridge] control plane already up"
    return 0
  fi

  echo "[onebridge] control plane not running — starting host…"
  # Supervisor keeps host/index.js alive across crashes.
  nohup bash "$ROOT/scripts/start-host.sh" >>"$SUPERVISOR_LOG" 2>&1 &
  disown 2>/dev/null || true

  local i
  for i in $(seq 1 60); do
    if control_plane_ok; then
      echo "[onebridge] control plane ready"
      return 0
    fi
    sleep 0.5
  done

  echo "[onebridge] control plane failed to start" >&2
  echo "[onebridge] host log: $HOST_LOG" >&2
  echo "[onebridge] supervisor log: $SUPERVISOR_LOG" >&2
  tail -n 40 "$HOST_LOG" 2>/dev/null >&2 || true
  exit 1
}

ensure_control_plane

cd "$DIR"

if [[ "$(uname -s)" == "Darwin" ]] && [[ -d "$ELECTRON_APP" ]]; then
  # `open` attaches to WindowServer so the window appears in the Dock / foreground.
  exec open -n -a "$ELECTRON_APP" --args "$DIR"
fi

exec env -u ELECTRON_RUN_AS_NODE "$ELECTRON_BIN" .
