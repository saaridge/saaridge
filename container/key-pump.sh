#!/bin/bash
# Read TYPE/KEY lines from stdin and inject via XTEST (not XSendEvent).
# --window uses XSendEvent, which Chromium/Electron ignore — so never use it.
export DISPLAY="${DISPLAY:-:1}"

# Keycode 204 is Alt_L on this Xvfb layout; if it latches, every letter becomes ESC+letter.
# Clear once at pump start — not per keystroke (that kills OS auto-repeat).
xdotool keyup \
  Shift_L Shift_R Control_L Control_R \
  Alt_L Alt_R Meta_L Meta_R Super_L Super_R \
  ISO_Level3_Shift Mode_switch 204 2>/dev/null || true

# Editing chords (ctrl+a/z/x/…) fail when a modifier is stuck; keep repeat usable.
xset r on 2>/dev/null || true

while IFS= read -r line; do
  if [[ "$line" == TYPE\ * ]]; then
    text="${line#TYPE }"
    xdotool type --delay 0 -- "$text"
  elif [[ "$line" == KEY\ * ]]; then
    key="${line#KEY }"
    # --clearmodifiers: drop latched Alt/Meta so ctrl+a/z/x reach GTK/Chromium.
    xdotool key --clearmodifiers -- "$key"
  elif [[ "$line" == RAWKEY\ * ]]; then
    # Rare path: do not clear modifiers (caller owns them).
    key="${line#RAWKEY }"
    xdotool key -- "$key"
  fi
done
