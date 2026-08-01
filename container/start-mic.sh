#!/usr/bin/env bash
# Virtual host microphone: null-sink + monitor as default source, fed by mic-ingress (:6083).
# Idempotent. Called from start-audio.sh / audio-watchdog.
set -uo pipefail

export HOME="${HOME:-/home/browser}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-browser}"
export PULSE_RUNTIME_PATH="${PULSE_RUNTIME_PATH:-$XDG_RUNTIME_DIR/pulse}"
export PULSE_SERVER="${PULSE_SERVER:-unix:${PULSE_RUNTIME_PATH}/native}"
export MIC_WS_PORT="${MIC_WS_PORT:-6083}"
export MIC_PULSE_SINK="${MIC_PULSE_SINK:-onebridge-mic-sink}"

has_mic_sink() {
  pactl --server="$PULSE_SERVER" list short sinks 2>/dev/null | grep -qE "(^|[[:space:]])${MIC_PULSE_SINK}([[:space:]]|$)"
}

has_mic_source() {
  # Prefer remapped name; fall back to sink monitor.
  pactl --server="$PULSE_SERVER" list short sources 2>/dev/null | grep -qE '(^|[[:space:]])onebridge-mic([[:space:]]|$)' \
    || pactl --server="$PULSE_SERVER" list short sources 2>/dev/null | grep -q "${MIC_PULSE_SINK}.monitor"
}

mic_listening() {
  ss -lnt 2>/dev/null | grep -q ":${MIC_WS_PORT} "
}

mic_healthy() {
  [[ -S "${PULSE_RUNTIME_PATH}/native" ]] && has_mic_sink && has_mic_source && mic_listening
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

if ! has_mic_sink; then
  pactl --server="$PULSE_SERVER" load-module module-null-sink \
    sink_name="$MIC_PULSE_SINK" \
    rate=48000 \
    channels=1 \
    sink_properties=device.description=OneBridge_Microphone_Sink \
    >/tmp/pulse-mic-sink.log 2>&1 || true
fi

if ! has_mic_sink; then
  echo "[start-mic] ERROR: ${MIC_PULSE_SINK} not created" >&2
  cat /tmp/pulse-mic-sink.log 2>/dev/null >&2 || true
  exit 1
fi

# Friendly source name for apps (optional remap).
if ! pactl --server="$PULSE_SERVER" list short sources 2>/dev/null | grep -qE '(^|[[:space:]])onebridge-mic([[:space:]]|$)'; then
  pactl --server="$PULSE_SERVER" load-module module-remap-source \
    source_name=onebridge-mic \
    master="${MIC_PULSE_SINK}.monitor" \
    source_properties=device.description=OneBridge_Microphone \
    >/tmp/pulse-mic-remap.log 2>&1 || true
fi

if pactl --server="$PULSE_SERVER" list short sources 2>/dev/null | grep -qE '(^|[[:space:]])onebridge-mic([[:space:]]|$)'; then
  pactl --server="$PULSE_SERVER" set-default-source onebridge-mic 2>/dev/null || true
  pactl --server="$PULSE_SERVER" set-source-mute onebridge-mic 0 2>/dev/null || true
  pactl --server="$PULSE_SERVER" set-source-volume onebridge-mic 100% 2>/dev/null || true
else
  pactl --server="$PULSE_SERVER" set-default-source "${MIC_PULSE_SINK}.monitor" 2>/dev/null || true
  pactl --server="$PULSE_SERVER" set-source-mute "${MIC_PULSE_SINK}.monitor" 0 2>/dev/null || true
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

echo "[start-mic] OK virtual mic + :${MIC_WS_PORT} (sink=$MIC_PULSE_SINK)"
exit 0
