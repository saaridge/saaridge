#!/usr/bin/env bash
# Move/resize normal windows so they stay inside the current screen.
set -uo pipefail
export DISPLAY="${DISPLAY:-:1}"

W="${1:-}"
H="${2:-}"
if [[ -z "$W" || -z "$H" ]]; then
  # Parse from xrandr current mode
  cur="$(xrandr 2>/dev/null | awk '/\*/{print $1; exit}')"
  W="${cur%x*}"
  H="${cur#*x}"
fi
W=$((W))
H=$((H))
if ((W < 100 || H < 100)); then
  exit 0
fi

if ! command -v wmctrl >/dev/null 2>&1; then
  exit 0
fi

# Desktop / panel strut: leave a little margin for the XFCE panel
MARGIN=8
PANEL=28
USABLE_H=$((H - PANEL - MARGIN))
USABLE_W=$((W - 2 * MARGIN))
if ((USABLE_H < 200)); then USABLE_H=$((H - MARGIN)); fi

wmctrl -lG 2>/dev/null | while read -r id desk x y w h rest; do
  # Skip sticky desktop/panel (desk -1 often)
  case "$desk" in
    -1) continue ;;
  esac
  # Skip invalid
  if [[ -z "$id" || -z "$w" ]]; then continue; fi

  nx=$x
  ny=$y
  nw=$w
  nh=$h
  changed=0

  if ((nw > USABLE_W)); then nw=$USABLE_W; changed=1; fi
  if ((nh > USABLE_H)); then nh=$USABLE_H; changed=1; fi
  if ((nx < MARGIN)); then nx=$MARGIN; changed=1; fi
  if ((ny < MARGIN)); then ny=$MARGIN; changed=1; fi
  if ((nx + nw > W - MARGIN)); then nx=$((W - MARGIN - nw)); changed=1; fi
  if ((ny + nh > H - MARGIN)); then ny=$((H - MARGIN - nh)); changed=1; fi
  if ((nx < MARGIN)); then nx=$MARGIN; fi
  if ((ny < MARGIN)); then ny=$MARGIN; fi

  if ((changed)); then
    wmctrl -i -r "$id" -e "0,$nx,$ny,$nw,$nh" 2>/dev/null || true
  fi
done

# Refresh desktop/panel layout for new geometry
wmctrl -r Desktop -b add,below 2>/dev/null || true
exit 0
