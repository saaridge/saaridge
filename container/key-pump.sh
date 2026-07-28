#!/bin/bash
# Read TYPE/KEY lines from stdin and inject via XTEST (not XSendEvent).
# --window uses XSendEvent, which Chromium/Electron ignore — so never use it.
export DISPLAY="${DISPLAY:-:1}"
while IFS= read -r line; do
  if [[ "$line" == TYPE\ * ]]; then
    text="${line#TYPE }"
    xdotool type --clearmodifiers --delay 0 -- "$text"
  elif [[ "$line" == KEY\ * ]]; then
    key="${line#KEY }"
    xdotool key --clearmodifiers -- "$key"
  fi
done
