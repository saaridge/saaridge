#!/bin/bash
# Launch Saaridge into the interactive macOS GUI session.
# 1) Require Docker (prompt if missing; start daemon if stopped)
# 2) Ensure the host control plane (:3847) is up and loadable
# 3) Start Electron
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
ELECTRON_BIN="$DIR/node_modules/.bin/electron"
ELECTRON_APP="$DIR/node_modules/electron/dist/Electron.app"

export SAARIDGE_ROOT="$ROOT"
# shellcheck source=../scripts/ensure-docker.sh
source "$ROOT/scripts/ensure-docker.sh"
# shellcheck source=../scripts/lib/host-stack.sh
source "$ROOT/scripts/lib/host-stack.sh"
ensure_docker

export ELECTRON_RUN_AS_NODE=
unset ELECTRON_RUN_AS_NODE

ensure_control_plane() {
  if saaridge_host_ready; then
    echo "[saaridge] control plane already up"
    return 0
  fi

  echo "[saaridge] control plane not ready — resetting host stack…"
  saaridge_stop_host_stack
  echo "[saaridge] starting host supervisor…"
  nohup bash "$ROOT/scripts/start-host.sh" >>"$SAARIDGE_SUPERVISOR_LOG" 2>&1 &
  disown 2>/dev/null || true

  if saaridge_wait_host_ready 90; then
    echo "[saaridge] control plane ready"
    return 0
  fi

  echo "[saaridge] control plane failed to start" >&2
  echo "[saaridge] host log: $SAARIDGE_HOST_LOG" >&2
  echo "[saaridge] supervisor log: $SAARIDGE_SUPERVISOR_LOG" >&2
  tail -n 80 "$SAARIDGE_HOST_LOG" 2>/dev/null >&2 || true
  exit 1
}

ensure_control_plane

cd "$DIR"

if [[ "$(uname -s)" == "Darwin" ]] && [[ -d "$ELECTRON_APP" ]]; then
  exec open -n -a "$ELECTRON_APP" --args "$DIR"
fi

exec env -u ELECTRON_RUN_AS_NODE "$ELECTRON_BIN" .
