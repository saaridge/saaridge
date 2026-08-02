#!/bin/bash
# Read TYPE/KEY lines from stdin and inject via XTEST (not XSendEvent).
# --window uses XSendEvent, which Chromium/Electron ignore — so never use it.
export DISPLAY="${DISPLAY:-:1}"

# Keycode 204 is Alt_L on this Xvfb layout; if it latches, every letter becomes ESC+letter.
release_stuck_mods() {
  xdotool keyup \
    Shift_L Shift_R Control_L Control_R \
    Alt_L Alt_R Meta_L Meta_R Super_L Super_R \
    ISO_Level3_Shift Mode_switch 204 2>/dev/null || true
}

release_stuck_mods

while IFS= read -r line; do
  if [[ "$line" == TYPE\ * ]]; then
    text="${line#TYPE }"
    release_stuck_mods
    xdotool type --delay 0 -- "$text"
  elif [[ "$line" == KEY\ * ]]; then
    key="${line#KEY }"
    release_stuck_mods
    xdotool key -- "$key"
  fi
done
