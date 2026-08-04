#!/usr/bin/env bash
# Keep OneBridge host (control UI + bridge + proxy) running.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOG="${ONEBRIDGE_HOST_LOG:-/tmp/onebridge-host.log}"
PIDFILE="${ONEBRIDGE_HOST_PIDFILE:-/tmp/onebridge-host.pid}"
CONTROL_URL="${ONEBRIDGE_CONTROL_URL:-http://127.0.0.1:3847}"

control_plane_ok() {
  curl -sf --connect-timeout 1 --max-time 2 \
    "${CONTROL_URL}/api/health" >/dev/null 2>&1
}

control_plane_modules_ok() {
  local code
  code="$(
    curl -s -o /dev/null -w "%{http_code}" --connect-timeout 1 --max-time 5 \
      "${CONTROL_URL}/api/desktop/stream-health" 2>/dev/null || echo 000
  )"
  [[ "$code" == "200" || "$code" == "503" ]]
}

free_ports() {
  if command -v lsof >/dev/null 2>&1; then
    for p in 3847 7331 7332 7333; do
      # shellcheck disable=SC2046
      kill $(lsof -t -iTCP:"$p" -sTCP:LISTEN 2>/dev/null) 2>/dev/null || true
    done
  fi
  sleep 0.4
}

# Another start-host supervisor already owns a healthy host — stay out.
if [[ -f "$PIDFILE" ]]; then
  old="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [[ -n "${old}" ]] && kill -0 "$old" 2>/dev/null; then
    if ps -p "$old" -o args= 2>/dev/null | grep -q "host/index.js"; then
      if control_plane_ok && control_plane_modules_ok; then
        echo "[start-host] host already running pid=$old"
        exit 0
      fi
      echo "[start-host] host pid=$old unhealthy — replacing"
      kill "$old" 2>/dev/null || true
      sleep 0.3
    fi
  fi
fi

# Healthy control plane from a prior start — do not kill it.
if control_plane_ok && control_plane_modules_ok; then
  echo "[start-host] control plane already healthy at $CONTROL_URL"
  exit 0
fi

# Stale / half-dead listeners (health green, modules broken, or ports busy)
free_ports

echo "[start-host] supervising node host/index.js → $LOG"
while true; do
  node host/index.js >>"$LOG" 2>&1 &
  PID=$!
  echo "$PID" >"$PIDFILE"
  echo "[start-host] host pid=$PID at $(date)" >>"$LOG"
  wait "$PID" || true
  code=$?
  echo "[start-host] host exited code=$code at $(date); restarting in 1s" >>"$LOG"
  # Clear listeners left by a crashed process before relaunch
  free_ports
  sleep 1
done
