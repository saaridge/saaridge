#!/usr/bin/env bash
# Virtual host microphone: null-sink monitor as capture device (input-only).
# Host PCM → mic-ingress → ffmpeg → onebridge-mic-sink (never the speaker sink).
set -uo pipefail

export HOME="${HOME:-/home/browser}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-browser}"
export PULSE_RUNTIME_PATH="${PULSE_RUNTIME_PATH:-$XDG_RUNTIME_DIR/pulse}"
export PULSE_SERVER="${PULSE_SERVER:-unix:${PULSE_RUNTIME_PATH}/native}"
export MIC_WS_PORT="${MIC_WS_PORT:-6083}"
export MIC_PULSE_SINK="${MIC_PULSE_SINK:-onebridge-mic-sink}"
export MIC_SOURCE="${MIC_SOURCE:-onebridge-mic}"

mic_listening() {
  ss -lnt 2>/dev/null | grep -q ":${MIC_WS_PORT} "
}

has_mic_sink() {
  pactl --server="$PULSE_SERVER" list short sinks 2>/dev/null \
    | grep -qE "(^|[[:space:]])${MIC_PULSE_SINK}([[:space:]]|$)"
}

has_mic_source() {
  pactl --server="$PULSE_SERVER" list short sources 2>/dev/null \
    | grep -qE "(^|[[:space:]])${MIC_SOURCE}([[:space:]]|$)"
}

mic_healthy() {
  [[ -S "${PULSE_RUNTIME_PATH}/native" ]] && has_mic_sink && has_mic_source && mic_listening
}

unload_pipe_source_modules() {
  pactl --server="$PULSE_SERVER" list short modules 2>/dev/null \
    | while read -r idx name _; do
        [[ "$name" == "module-pipe-source" ]] || continue
        pactl --server="$PULSE_SERVER" unload-module "$idx" 2>/dev/null || true
      done
}

unload_mic_loopback() {
  pactl --server="$PULSE_SERVER" list short modules 2>/dev/null \
    | while read -r idx name _; do
        [[ "$name" == "module-loopback" ]] || continue
        args="$(pactl --server="$PULSE_SERVER" list modules "$idx" 2>/dev/null || true)"
        if echo "$args" | grep -qiE 'onebridge-mic|onebridge-mic-sink'; then
          pactl --server="$PULSE_SERVER" unload-module "$idx" 2>/dev/null || true
        fi
      done
}

if [[ "${1:-}" == "--check" ]]; then
  if mic_healthy; then
    exit 0
  fi
  exit 1
fi

if [[ ! -S "${PULSE_RUNTIME_PATH}/native" ]]; then
  echo "[start-mic] ERROR: Pulse socket missing" >&2
  exit 1
fi

if mic_healthy; then
  unload_mic_loopback
  pactl --server="$PULSE_SERVER" set-default-source "$MIC_SOURCE" 2>/dev/null || true
  pactl --server="$PULSE_SERVER" set-default-sink onebridge 2>/dev/null || true
  echo "[start-mic] OK already (sink=$MIC_PULSE_SINK :${MIC_WS_PORT})"
  exit 0
fi

unload_pipe_source_modules
rm -f /tmp/onebridge-mic.fifo 2>/dev/null || true
unload_mic_loopback

if ! has_mic_sink; then
  pactl --server="$PULSE_SERVER" load-module module-null-sink \
    sink_name="$MIC_PULSE_SINK" \
    rate=48000 \
    channels=1 \
    sink_properties=device.description=OneBridge_Microphone_Sink,device.class=filter \
    >/tmp/pulse-mic-sink.log 2>&1 || true
fi

if ! has_mic_sink; then
  echo "[start-mic] ERROR: ${MIC_PULSE_SINK} not created" >&2
  cat /tmp/pulse-mic-sink.log 2>/dev/null >&2 || true
  exit 1
fi

if ! has_mic_source; then
  pactl --server="$PULSE_SERVER" load-module module-remap-source \
    source_name="$MIC_SOURCE" \
    master="${MIC_PULSE_SINK}.monitor" \
    source_properties=device.description=OneBridge_Microphone \
    >/tmp/pulse-mic-remap.log 2>&1 || true
fi

if ! mic_listening; then
  pkill -f "mic-ingress.mjs" 2>/dev/null || true
  sleep 0.2
  nohup env PULSE_SERVER="$PULSE_SERVER" MIC_PULSE_SINK="$MIC_PULSE_SINK" MIC_WS_PORT="$MIC_WS_PORT" \
    HOME="$HOME" XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
    PULSE_RUNTIME_PATH="$PULSE_RUNTIME_PATH" \
    node /opt/bridge/mic-ingress.mjs >/tmp/mic-ingress.log 2>&1 &
  for _ in $(seq 1 25); do
    if mic_listening; then
      break
    fi
    sleep 0.2
  done
fi

if ! mic_listening; then
  echo "[start-mic] ERROR: mic-ingress did not listen on :${MIC_WS_PORT}" >&2
  cat /tmp/mic-ingress.log 2>/dev/null >&2 || true
  exit 1
fi

pactl --server="$PULSE_SERVER" set-default-source "$MIC_SOURCE" 2>/dev/null || true
pactl --server="$PULSE_SERVER" set-source-mute "$MIC_SOURCE" 0 2>/dev/null || true
pactl --server="$PULSE_SERVER" set-source-volume "$MIC_SOURCE" 100% 2>/dev/null || true
pactl --server="$PULSE_SERVER" set-default-sink onebridge 2>/dev/null || true

# Speaker egress (noVNC) must capture onebridge.monitor only — never the mic monitor.
pactl --server="$PULSE_SERVER" set-source-volume onebridge.monitor 100% 2>/dev/null || true

echo "[start-mic] OK virtual mic (sink=$MIC_PULSE_SINK source=$MIC_SOURCE :${MIC_WS_PORT})"
exit 0
