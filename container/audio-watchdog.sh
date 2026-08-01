#!/usr/bin/env bash
# Keep Pulse + audio-stream (:6082) alive for the host viewer.
# Mirrors hostfs-watchdog: transient failures must not kill the loop.
# Single-instance via flock + pidfile (never pkill -f this script name from a
# shell whose -c string contains the same path — that suicides the parent).
set -u

export HOME="${HOME:-/home/browser}"
export DISPLAY="${DISPLAY:-:1}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-browser}"
export PULSE_RUNTIME_PATH="${PULSE_RUNTIME_PATH:-$XDG_RUNTIME_DIR/pulse}"
export AUDIO_WS_PORT="${AUDIO_WS_PORT:-6082}"

START_AUDIO="${START_AUDIO:-/usr/local/bin/start-audio.sh}"
INTERVAL_SEC="${AUDIO_WATCHDOG_INTERVAL_SEC:-5}"
BACKOFF_SEC=2
PIDFILE="${AUDIO_WATCHDOG_PIDFILE:-/tmp/audio-watchdog.pid}"
LOCKFILE="${AUDIO_WATCHDOG_LOCKFILE:-/tmp/audio-watchdog.lock}"

ensure_exec() {
  if [[ -f "$START_AUDIO" && ! -x "$START_AUDIO" ]]; then
    chmod 755 "$START_AUDIO" 2>/dev/null || true
  fi
}

# Exclusive lock — second start exits quietly
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  echo "[audio-watchdog] already running"
  exit 0
fi
echo $$ >"$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT

echo "[audio-watchdog] watching pulse + :${AUDIO_WS_PORT} + mic (pid=$$ start=$START_AUDIO)"
while true; do
  ensure_exec
  if [[ ! -x "$START_AUDIO" ]]; then
    echo "[audio-watchdog] start-audio missing/not executable — retrying"
    sleep "$BACKOFF_SEC"
    continue
  fi
  mic_ok=1
  if [[ -x /usr/local/bin/start-mic.sh ]]; then
    /usr/local/bin/start-mic.sh --check >/dev/null 2>&1 || mic_ok=0
  fi
  if ! "$START_AUDIO" --check >/dev/null 2>&1 || [[ "$mic_ok" -eq 0 ]]; then
    echo "[audio-watchdog] audio unhealthy — repairing"
    if "$START_AUDIO" >>/tmp/start-audio.log 2>&1; then
      echo "[audio-watchdog] repaired OK"
      BACKOFF_SEC=2
    else
      echo "[audio-watchdog] repair failed — see /tmp/start-audio.log"
      BACKOFF_SEC=$((BACKOFF_SEC < 30 ? BACKOFF_SEC * 2 : 30))
      sleep "$BACKOFF_SEC"
      continue
    fi
  fi
  sleep "$INTERVAL_SEC"
done
