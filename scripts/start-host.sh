#!/usr/bin/env bash
# Keep Saaridge host (control UI + bridge + proxy) running.
# Single-instance via mkdir lock (macOS has no flock by default).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/host-stack.sh
source "$ROOT/scripts/lib/host-stack.sh"
SAARIDGE_ROOT="$ROOT"
cd "$ROOT"

# Never run two supervisors (Electron + launch-mac + manual shells fight over ports).
while read -r peer; do
  [[ -z "${peer:-}" || "$peer" == "$$" ]] && continue
  if kill -0 "$peer" 2>/dev/null; then
    if saaridge_host_ready; then
      echo "[start-host] supervisor $peer already runs a healthy host — exiting"
      exit 0
    fi
    echo "[start-host] waiting for peer supervisor $peer to settle…"
    sleep 0.5
    if saaridge_host_ready; then
      echo "[start-host] host ready under peer $peer — exiting"
      exit 0
    fi
  fi
done < <(pgrep -f "start-host\\.sh" 2>/dev/null || true)

# Packaged macOS apps get a minimal PATH; Docker CLI lives outside it.
for d in \
  /usr/local/bin \
  /opt/homebrew/bin \
  /Applications/Docker.app/Contents/Resources/bin \
  "$HOME/Applications/Docker.app/Contents/Resources/bin"
do
  if [[ -d "$d" && ":$PATH:" != *":$d:"* ]]; then
    PATH="$d:$PATH"
  fi
done
export PATH

LOG="$SAARIDGE_HOST_LOG"
PIDFILE="$SAARIDGE_HOST_PIDFILE"

cleanup() {
  saaridge_release_supervisor_lock
}
trap cleanup EXIT INT TERM

if ! saaridge_acquire_supervisor_lock; then
  if saaridge_host_ready; then
    echo "[start-host] another supervisor owns a healthy host — exiting"
    exit 0
  fi
  echo "[start-host] waiting for the other supervisor…"
  if saaridge_wait_host_ready 40; then
    echo "[start-host] host ready under the other supervisor"
    exit 0
  fi
  echo "[start-host] other supervisor failed — taking over"
  saaridge_stop_host_stack
  if ! saaridge_acquire_supervisor_lock; then
    echo "[start-host] could not acquire supervisor lock" >&2
    exit 1
  fi
fi

echo $$ >"$SAARIDGE_SUPERVISOR_PIDFILE"
echo "[start-host] supervising node host/index.js → $LOG"

while true; do
  saaridge_free_ports
  NODE_BIN="${SAARIDGE_NODE:-node}"
  if [[ -n "${SAARIDGE_ELECTRON_AS_NODE:-}" ]]; then
    env ELECTRON_RUN_AS_NODE=1 "$NODE_BIN" host/index.js >>"$LOG" 2>&1 &
  else
    "$NODE_BIN" host/index.js >>"$LOG" 2>&1 &
  fi
  PID=$!
  echo "$PID" >"$PIDFILE"
  echo "[start-host] host pid=$PID at $(date)" >>"$LOG"
  wait "$PID" || true
  code=$?
  echo "[start-host] host exited code=$code at $(date); restarting in 1s" >>"$LOG"
  saaridge_free_ports
  sleep 1
done
