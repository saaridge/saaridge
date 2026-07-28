#!/usr/bin/env bash
# Read mouse lines from stdin and inject into the X session (DISPLAY=:1).
# Protocol (one command per line):
#   MOVE x y
#   DOWN button
#   UP button
#   CLICK button
set -uo pipefail
export DISPLAY="${DISPLAY:-:1}"

while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" ]] && continue
  cmd="${line%% *}"
  rest="${line#* }"
  case "$cmd" in
    MOVE)
      x="${rest%% *}"
      y="${rest#* }"
      xdotool mousemove --sync "$x" "$y" 2>/dev/null || xdotool mousemove "$x" "$y" 2>/dev/null || true
      ;;
    DOWN)
      xdotool mousedown "$rest" 2>/dev/null || true
      ;;
    UP)
      xdotool mouseup "$rest" 2>/dev/null || true
      ;;
    CLICK)
      xdotool click "$rest" 2>/dev/null || true
      ;;
  esac
done
