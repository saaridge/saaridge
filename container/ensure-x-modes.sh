#!/usr/bin/env bash
# Register RANDR modes so x11vnc ExtDesktopSize can shrink/grow within Xvfb max.
set -uo pipefail
export DISPLAY="${DISPLAY:-:1}"

add_mode() {
  local w=$1 h=$2
  local name="${w}x${h}"
  local clock
  clock="$(awk -v w="$w" -v h="$h" 'BEGIN { printf "%.2f", (w * h * 60) / 1000000 }')"
  xrandr --newmode "$name" "$clock" "$w" "$((w + 48))" "$((w + 192))" "$((w + 240))" \
    "$h" "$((h + 3))" "$((h + 7))" "$((h + 20))" -hsync +vsync 2>/dev/null || true
  xrandr --addmode screen "$name" 2>/dev/null || true
}

for w in 1024 1280 1360 1366 1400 1440 1536 1600 1680 1728 1800 1920; do
  for h in 640 720 768 800 850 856 900 960 1020 1036 1050 1080; do
    add_mode "$w" "$h"
  done
done

echo "modes-ready"
xrandr | head -20
