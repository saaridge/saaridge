#!/usr/bin/env bash
# Repair XFCE window manager so app windows can be focused/closed again.
set -uo pipefail
export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/home/browser}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-browser}"

LOG=/tmp/repair-desktop.log
echo "[repair $(date -Is)] start" >>"$LOG"

# Inherit session bus / session manager from the live XFCE session
SESSION_PID="$(pgrep -u "$(id -u)" -x xfce4-session | head -1 || true)"
if [[ -n "${SESSION_PID:-}" && -r "/proc/${SESSION_PID}/environ" ]]; then
  while IFS= read -r -d '' entry; do
    case "$entry" in
      DBUS_SESSION_BUS_ADDRESS=*|SESSION_MANAGER=*|XDG_CURRENT_DESKTOP=*|DESKTOP_SESSION=*)
        export "$entry"
        ;;
    esac
  done < "/proc/${SESSION_PID}/environ"
fi

# Close stuck user apps (not the desktop shell itself)
pkill -x thunar >/dev/null 2>&1 || true
pkill -x zenity >/dev/null 2>&1 || true
# Only Chromium browsers — do not match random command lines
pkill -u "$(id -u)" -f '/usr/lib/chromium/chromium' >/dev/null 2>&1 || true
sleep 0.3

# Restore sensible window-manager behavior
xfconf-query -c xfwm4 -p /general/click_to_focus -s true 2>/dev/null || true
xfconf-query -c xfwm4 -p /general/raise_on_click -s true 2>/dev/null || true
xfconf-query -c xfwm4 -p /general/raise_with_any_button -s true 2>/dev/null || true
xfconf-query -c xfwm4 -p /general/focus_delay -s 0 2>/dev/null || true
xfconf-query -c xfwm4 -p /general/button_layout -s "O|HMC" 2>/dev/null || true
# Do NOT set easy_click to Super — that breaks normal single-clicks.
xfconf-query -c xfwm4 -p /general/easy_click -s None 2>/dev/null || true

# Restart window manager with session env
pkill -x xfwm4 >/dev/null 2>&1 || true
sleep 0.4
nohup xfwm4 >>"$LOG" 2>&1 &
sleep 0.8

# Keep desktop icons below normal windows
wmctrl -r Desktop -b add,below 2>/dev/null || true

# Ensure WM is alive
if ! pgrep -u "$(id -u)" -x xfwm4 >/dev/null 2>&1; then
  echo "[repair] xfwm4 failed to stay up" >>"$LOG"
  nohup xfwm4 >>"$LOG" 2>&1 &
  sleep 0.5
fi

echo "[repair $(date -Is)] done wm=$(pgrep -u "$(id -u)" -x xfwm4 | tr '\n' ' ')" >>"$LOG"
echo REPAIRED
