#!/bin/bash
# Launch OneBridge into the interactive macOS GUI session.
# 1) Require Docker (prompt if missing; start daemon if stopped)
# 2) Ensure the host control plane (:3847) is up and loadable
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
PIDFILE="${ONEBRIDGE_HOST_PIDFILE:-/tmp/onebridge-host.pid}"

export ELECTRON_RUN_AS_NODE=
unset ELECTRON_RUN_AS_NODE

# shellcheck source=../scripts/ensure-docker.sh
source "$ROOT/scripts/ensure-docker.sh"
ensure_docker

control_plane_ok() {
  curl -sf --connect-timeout 1 --max-time 2 \
    "${CONTROL_URL}/api/health" >/dev/null 2>&1
}

# /api/health can stay green while a bad dynamic import crashes ensure/stream.
# stream-health loads stream-stack.js — 500 means the host must be restarted.
control_plane_modules_ok() {
  local code
  code="$(
    curl -s -o /dev/null -w "%{http_code}" --connect-timeout 1 --max-time 5 \
      "${CONTROL_URL}/api/desktop/stream-health" 2>/dev/null || echo 000
  )"
  # 200 = stream healthy, 503 = modules loaded but stream not ready yet
  [[ "$code" == "200" || "$code" == "503" ]]
}

stop_host_stack() {
  echo "[onebridge] stopping existing host stack…"
  if [[ -f "$PIDFILE" ]]; then
    local old
    old="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [[ -n "${old}" ]]; then
      kill "$old" 2>/dev/null || true
      # Also stop the supervisor parent if it is start-host.sh
      pkill -P "$old" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
  fi
  pkill -f "$ROOT/scripts/start-host.sh" 2>/dev/null || true
  pkill -f "node host/index.js" 2>/dev/null || true
  if command -v lsof >/dev/null 2>&1; then
    for p in 3847 7331 7332 7333; do
      # shellcheck disable=SC2046
      kill $(lsof -t -iTCP:"$p" -sTCP:LISTEN 2>/dev/null) 2>/dev/null || true
    done
  fi
  sleep 0.6
}

start_host_supervisor() {
  echo "[onebridge] starting host supervisor…"
  nohup bash "$ROOT/scripts/start-host.sh" >>"$SUPERVISOR_LOG" 2>&1 &
  disown 2>/dev/null || true
}

wait_for_control_plane() {
  local i
  for i in $(seq 1 60); do
    if control_plane_ok && control_plane_modules_ok; then
      echo "[onebridge] control plane ready"
      return 0
    fi
    sleep 0.5
  done
  return 1
}

ensure_control_plane() {
  if control_plane_ok && control_plane_modules_ok; then
    echo "[onebridge] control plane already up"
    return 0
  fi

  if control_plane_ok && ! control_plane_modules_ok; then
    echo "[onebridge] control plane responded but desktop modules failed — restarting host…"
    stop_host_stack
  elif ! control_plane_ok; then
    echo "[onebridge] control plane not running — starting host…"
  fi

  start_host_supervisor

  if wait_for_control_plane; then
    return 0
  fi

  echo "[onebridge] control plane failed to start" >&2
  echo "[onebridge] host log: $HOST_LOG" >&2
  echo "[onebridge] supervisor log: $SUPERVISOR_LOG" >&2
  tail -n 60 "$HOST_LOG" 2>/dev/null >&2 || true
  exit 1
}

ensure_control_plane

cd "$DIR"

if [[ "$(uname -s)" == "Darwin" ]] && [[ -d "$ELECTRON_APP" ]]; then
  # `open` attaches to WindowServer so the window appears in the Dock / foreground.
  exec open -n -a "$ELECTRON_APP" --args "$DIR"
fi

exec env -u ELECTRON_RUN_AS_NODE "$ELECTRON_BIN" .
