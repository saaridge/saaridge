#!/bin/bash
# Read TYPE/KEY lines from stdin and inject into the focused X window.
export DISPLAY="${DISPLAY:-:1}"
while IFS= read -r line; do
  wid="$(xdotool getwindowfocus 2>/dev/null || true)"
  if [[ "$line" == TYPE\ * ]]; then
    text="${line#TYPE }"
    if [[ -n "$wid" ]]; then
      xdotool type --clearmodifiers --window "$wid" --delay 0 -- "$text"
    else
      xdotool type --clearmodifiers --delay 0 -- "$text"
    fi
  elif [[ "$line" == KEY\ * ]]; then
    key="${line#KEY }"
    if [[ -n "$wid" ]]; then
      xdotool key --clearmodifiers --window "$wid" -- "$key"
    else
      xdotool key --clearmodifiers -- "$key"
    fi
  fi
done
