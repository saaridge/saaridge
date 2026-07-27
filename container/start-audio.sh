#!/usr/bin/env bash
# Virtual speaker + WebSocket audio stream for the host viewer.
# Failures are logged loudly; Pulse must be healthy before Chromium starts.
set -euo pipefail

export HOME="${HOME:-/home/browser}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-browser}"
export PULSE_RUNTIME_PATH="${PULSE_RUNTIME_PATH:-$XDG_RUNTIME_DIR/pulse}"
export PULSE_STATE_PATH="${PULSE_STATE_PATH:-$HOME/.config/pulse}"

mkdir -p "$XDG_RUNTIME_DIR" "$PULSE_RUNTIME_PATH" "$PULSE_STATE_PATH"
chmod 700 "$XDG_RUNTIME_DIR" || true

is_live_pulse() {
  local pid state
  for pid in $(pgrep -u "$(id -u)" -x pulseaudio 2>/dev/null || true); do
    state="$(ps -o state= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
    if [[ -n "$state" && "$state" != "Z" ]]; then
      return 0
    fi
  done
  return 1
}

# Kill a broken/zombie pulse and start fresh
if ! is_live_pulse; then
  pkill -u "$(id -u)" -x pulseaudio 2>/dev/null || true
  sleep 0.3
  # Daemonize with a dedicated runtime dir (headless / no system dbus)
  pulseaudio --daemonize=yes --exit-idle-time=-1 --disallow-exit \
    --log-target=file:/tmp/pulseaudio.log --log-level=info \
    >/tmp/pulseaudio-start.log 2>&1 || true
  sleep 0.8
fi

export PULSE_SERVER="unix:${PULSE_RUNTIME_PATH}/native"
# Wait for the socket
for _ in $(seq 1 20); do
  if [[ -S "${PULSE_RUNTIME_PATH}/native" ]]; then
    break
  fi
  sleep 0.25
done

if [[ ! -S "${PULSE_RUNTIME_PATH}/native" ]]; then
  echo "[start-audio] ERROR: Pulse socket missing at ${PULSE_RUNTIME_PATH}/native" >&2
  cat /tmp/pulseaudio.log 2>/dev/null | tail -40 >&2 || true
  cat /tmp/pulseaudio-start.log 2>/dev/null | tail -40 >&2 || true
  exit 1
fi

# Virtual speakers
pactl --server="$PULSE_SERVER" unload-module module-null-sink 2>/dev/null || true
pactl --server="$PULSE_SERVER" load-module module-null-sink sink_name=onebridge \
  sink_properties=device.description=OneBridge_Speaker >/tmp/pulse-sink.log 2>&1
pactl --server="$PULSE_SERVER" set-default-sink onebridge
pactl --server="$PULSE_SERVER" set-default-source onebridge.monitor
pactl --server="$PULSE_SERVER" set-sink-mute onebridge 0
pactl --server="$PULSE_SERVER" set-sink-volume onebridge 100%

# Sanity: list sinks
pactl --server="$PULSE_SERVER" list short sinks >/tmp/pulse-sinks.txt 2>&1 || true
if ! grep -q onebridge /tmp/pulse-sinks.txt 2>/dev/null; then
  echo "[start-audio] ERROR: onebridge sink not created" >&2
  cat /tmp/pulse-sink.log >&2 || true
  exit 1
fi

# Quick ffmpeg probe (must succeed)
if ! ffmpeg -y -f pulse -i onebridge.monitor -t 0.2 -f null - >/tmp/ffmpeg-probe.log 2>&1; then
  echo "[start-audio] ERROR: ffmpeg cannot capture onebridge.monitor" >&2
  cat /tmp/ffmpeg-probe.log >&2 || true
  exit 1
fi

export PULSE_MONITOR=onebridge.monitor
export AUDIO_WS_PORT="${AUDIO_WS_PORT:-6082}"
export PULSE_SERVER

pkill -f "audio-stream.mjs" 2>/dev/null || true
sleep 0.2
nohup env PULSE_SERVER="$PULSE_SERVER" PULSE_MONITOR="$PULSE_MONITOR" \
  AUDIO_WS_PORT="$AUDIO_WS_PORT" \
  node /opt/bridge/audio-stream.mjs >/tmp/audio-stream.log 2>&1 &

# Wait for listener
for _ in $(seq 1 15); do
  if ss -lnt 2>/dev/null | grep -q ":${AUDIO_WS_PORT} "; then
    echo "[start-audio] OK pulse + audio-stream on :${AUDIO_WS_PORT} (PULSE_SERVER=$PULSE_SERVER)"
    exit 0
  fi
  sleep 0.2
done

echo "[start-audio] ERROR: audio-stream did not listen on :${AUDIO_WS_PORT}" >&2
cat /tmp/audio-stream.log >&2 || true
exit 1
