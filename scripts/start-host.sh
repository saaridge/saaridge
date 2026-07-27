#!/usr/bin/env bash
# Keep OneBridge host (control UI + bridge + proxy) running.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOG="${ONEBRIDGE_HOST_LOG:-/tmp/onebridge-host.log}"
PIDFILE="${ONEBRIDGE_HOST_PIDFILE:-/tmp/onebridge-host.pid}"

if [[ -f "$PIDFILE" ]]; then
  old="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [[ -n "${old}" ]] && kill -0 "$old" 2>/dev/null; then
    # Already supervised by another start-host.sh
    if ps -p "$old" -o args= 2>/dev/null | grep -q "host/index.js"; then
      echo "[start-host] host already running pid=$old"
      exit 0
    fi
  fi
fi

# Free our ports once at startup (do not do this on every restart loop)
for p in 3847 7331 7332; do
  if command -v lsof >/dev/null 2>&1; then
    kill $(lsof -t -iTCP:"$p" -sTCP:LISTEN) 2>/dev/null || true
  fi
done
sleep 0.4

echo "[start-host] supervising node host/index.js → $LOG"
while true; do
  node host/index.js >>"$LOG" 2>&1 &
  PID=$!
  echo "$PID" >"$PIDFILE"
  echo "[start-host] host pid=$PID at $(date)" >>"$LOG"
  wait "$PID" || true
  code=$?
  echo "[start-host] host exited code=$code at $(date); restarting in 1s" >>"$LOG"
  sleep 1
done
