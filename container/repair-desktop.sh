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

# Restore sensible window-manager + double-click behavior (VNC clicks need
# a larger distance/time window or word/URL selection fails).
xfconf-query -c xfwm4 -p /general/click_to_focus -s true 2>/dev/null || true
xfconf-query -c xfwm4 -p /general/raise_on_click -s true 2>/dev/null || true
xfconf-query -c xfwm4 -p /general/raise_with_any_button -s true 2>/dev/null || true
xfconf-query -c xfwm4 -p /general/focus_delay -s 0 2>/dev/null || true
xfconf-query -c xfwm4 -p /general/button_layout -s "O|HMC" 2>/dev/null || true
# Do NOT set easy_click to Super — that breaks normal single-clicks.
xfconf-query -c xfwm4 -p /general/easy_click -s None 2>/dev/null || true
# VNC/scaled viewers need a generous window — tiny defaults make word/URL
# selection look like "only part of the text" or fail entirely.
xfconf-query -c xsettings -p /Net/DoubleClickTime -n -t int -s 900 2>/dev/null || \
  xfconf-query -c xsettings -p /Net/DoubleClickTime -s 900 2>/dev/null || true
xfconf-query -c xsettings -p /Net/DoubleClickDistance -n -t int -s 48 2>/dev/null || \
  xfconf-query -c xsettings -p /Net/DoubleClickDistance -s 48 2>/dev/null || true

# Chromium (GTK) reads these independently of xfsettings.
mkdir -p "$HOME/.config/gtk-3.0"
if [[ -f "$HOME/.config/gtk-3.0/settings.ini" ]]; then
  grep -q '^gtk-double-click-time=' "$HOME/.config/gtk-3.0/settings.ini" 2>/dev/null && \
    sed -i 's/^gtk-double-click-time=.*/gtk-double-click-time=900/' "$HOME/.config/gtk-3.0/settings.ini" || \
    printf '\ngtk-double-click-time=900\ngtk-double-click-distance=48\n' >>"$HOME/.config/gtk-3.0/settings.ini"
  grep -q '^gtk-double-click-distance=' "$HOME/.config/gtk-3.0/settings.ini" 2>/dev/null && \
    sed -i 's/^gtk-double-click-distance=.*/gtk-double-click-distance=48/' "$HOME/.config/gtk-3.0/settings.ini" || true
else
  cat >"$HOME/.config/gtk-3.0/settings.ini" <<'EOF'
[Settings]
gtk-double-click-time=900
gtk-double-click-distance=48
EOF
fi

# Restart window manager with session env
pkill -x xfwm4 >/dev/null 2>&1 || true
sleep 0.4
nohup xfwm4 >>"$LOG" 2>&1 &
sleep 0.8

# Desktop background + icons (blank screen = xfdesktop/panel died, often due to
# broken PNG loaders / icon theme).
if [[ -x /usr/lib/aarch64-linux-gnu/gdk-pixbuf-2.0/gdk-pixbuf-query-loaders ]]; then
  /usr/lib/aarch64-linux-gnu/gdk-pixbuf-2.0/gdk-pixbuf-query-loaders --update-cache 2>/dev/null || true
elif [[ -x /usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/gdk-pixbuf-query-loaders ]]; then
  /usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/gdk-pixbuf-query-loaders --update-cache 2>/dev/null || true
fi
if command -v xsetroot >/dev/null 2>&1; then
  xsetroot -solid "#1a2f28" 2>/dev/null || true
fi
xfconf-query -c xsettings -p /Net/IconThemeName -n -t string -s Adwaita 2>/dev/null || \
  xfconf-query -c xsettings -p /Net/IconThemeName -s Adwaita 2>/dev/null || true

# Do not restart xfdesktop if it is already running (second instance quits and
# leaves a broken desktop).
if ! pgrep -u "$(id -u)" -x xfdesktop >/dev/null 2>&1; then
  nohup xfdesktop >>"$LOG" 2>&1 &
  sleep 0.8
fi

# Never start a second panel — only remove orphans not owned by xfce4-session.
if [[ -x /opt/bridge/dedupe-xfce-panel.sh ]]; then
  /opt/bridge/dedupe-xfce-panel.sh >>"$LOG" 2>&1 || true
fi
if [[ -x /opt/bridge/ensure-panel-launchers.sh ]]; then
  /opt/bridge/ensure-panel-launchers.sh >>"$LOG" 2>&1 || true
fi

# Keep desktop icons below normal windows
wmctrl -r Desktop -b add,below 2>/dev/null || true

# Ensure WM is alive
if ! pgrep -u "$(id -u)" -x xfwm4 >/dev/null 2>&1; then
  echo "[repair] xfwm4 failed to stay up" >>"$LOG"
  nohup xfwm4 >>"$LOG" 2>&1 &
  sleep 0.5
fi

echo "[repair $(date -Is)] done wm=$(pgrep -u "$(id -u)" -x xfwm4 | tr '\n' ' ') desktop=$(pgrep -u "$(id -u)" -x xfdesktop | tr '\n' ' ') panel=$(pgrep -u "$(id -u)" -x xfce4-panel | tr '\n' ' ')" >>"$LOG"
echo REPAIRED
