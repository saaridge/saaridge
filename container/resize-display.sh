#!/usr/bin/env bash
# Resize the workspace X display to exactly WxH (viewer CSS pixels).
# Creates a RANDR mode on demand. Clamps to the X server maximum.
set -uo pipefail
export DISPLAY="${DISPLAY:-:1}"

W="${1:-}"
H="${2:-}"
if [[ -z "$W" || -z "$H" ]]; then
  echo "usage: resize-display.sh WIDTH HEIGHT" >&2
  exit 2
fi

# Even sizes are safer for Xvfb/RANDR; keep a usable minimum.
W=$((W))
H=$((H))
W=$((W - (W % 2)))
H=$((H - (H % 2)))
if ((W < 800)); then W=800; fi
if ((H < 600)); then H=600; fi

# Discover current X maximum (Xvfb max == initial screen size).
MAX_W=1920
MAX_H=1080
max_line="$(xrandr 2>/dev/null | awk '/maximum/{print; exit}')"
if [[ -n "$max_line" ]]; then
  # e.g. "Screen 0: minimum 1 x 1, current 1920 x 1080, maximum 3840 x 2160"
  MAX_W="$(echo "$max_line" | sed -n 's/.*maximum \([0-9][0-9]*\) x \([0-9][0-9]*\).*/\1/p')"
  MAX_H="$(echo "$max_line" | sed -n 's/.*maximum \([0-9][0-9]*\) x \([0-9][0-9]*\).*/\2/p')"
fi
MAX_W="${MAX_W:-1920}"
MAX_H="${MAX_H:-1080}"

CLAMPED=0
if ((W > MAX_W)); then W=$MAX_W; CLAMPED=1; fi
if ((H > MAX_H)); then H=$MAX_H; CLAMPED=1; fi

# Already at target?
cur="$(xrandr 2>/dev/null | awk '/\*/{print $1; exit}')"
if [[ "$cur" == "${W}x${H}" ]]; then
  echo "already ${W}x${H}"
  exit 0
fi

NAME="${W}x${H}"
if ! xrandr 2>/dev/null | grep -qE "^[[:space:]]+${NAME}([[:space:]]|$)"; then
  CLOCK="$(awk -v w="$W" -v h="$H" 'BEGIN { printf "%.2f", (w * h * 60) / 1000000 }')"
  xrandr --newmode "$NAME" "$CLOCK" "$W" "$((W + 48))" "$((W + 192))" "$((W + 240))" \
    "$H" "$((H + 3))" "$((H + 7))" "$((H + 20))" -hsync +vsync 2>/dev/null || true
  xrandr --addmode screen "$NAME" 2>/dev/null || true
fi

if xrandr --output screen --mode "$NAME" 2>/dev/null; then
  # Keep open windows inside the new desktop so nothing looks "cropped".
  if [[ -x /opt/bridge/fit-windows.sh ]]; then
    /opt/bridge/fit-windows.sh "$W" "$H" >/dev/null 2>&1 || true
  fi
  if ((CLAMPED)); then
    echo "resized ${NAME} (clamped to X max ${MAX_W}x${MAX_H})"
  else
    echo "resized ${NAME}"
  fi
  exit 0
fi

if xrandr --fb "${NAME}" 2>/dev/null; then
  [[ -x /opt/bridge/fit-windows.sh ]] && /opt/bridge/fit-windows.sh "$W" "$H" >/dev/null 2>&1 || true
  echo "fb ${NAME}"
  exit 0
fi

echo "resize-failed ${NAME} max=${MAX_W}x${MAX_H}" >&2
xrandr 2>&1 | head -12 >&2
exit 1
