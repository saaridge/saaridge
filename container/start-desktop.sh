#!/usr/bin/env bash
# Personal-computer style desktop: XFCE + browser icon. No terminals.
# Browser opens once at session start; closing it does NOT auto-reopen.
set -euo pipefail

export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/home/browser}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export BRIDGE_CREDENTIALS_FILE="${BRIDGE_CREDENTIALS_FILE:-$HOME/.bridge-credentials}"

mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" \
  "$HOME/Desktop" "$HOME/Downloads" "$HOME/chromium-bridge-profile" \
  "$HOME/.local/share/applications"

CRED_FILE="$BRIDGE_CREDENTIALS_FILE"
PORT="${LOCAL_PROXY_PORT:-}"
if [[ -z "$PORT" && -f "$CRED_FILE" ]]; then
  PORT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["localProxyPort"])' "$CRED_FILE")"
fi
PORT="${PORT:-17999}"
PROXY="http://127.0.0.1:${PORT}"

export http_proxy="$PROXY" https_proxy="$PROXY" HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY"
export NO_PROXY="127.0.0.1,localhost,host.docker.internal"
export BROWSER="/opt/bridge/launch-browser.sh"

# Close any leftover technical terminals from older sessions
pkill -u "$(id -u)" -f "xfce4-terminal" 2>/dev/null || true
pkill -u "$(id -u)" -f "xterm" 2>/dev/null || true

if command -v xsetroot >/dev/null 2>&1; then
  xsetroot -solid "#1a2f28"
fi

# Desktop + apps menu launcher (double-click like a normal PC)
write_browser_launcher() {
  local dest="$1"
  cat > "$dest" <<'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Web Browser
Comment=Browse the internet
Exec=/opt/bridge/launch-browser.sh %u
Icon=web-browser
Terminal=false
Categories=Network;WebBrowser;
StartupNotify=true
MimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;
EOF
  chmod +x "$dest"
}

# Apps menu launcher only — no browser icon on the Desktop by default
write_browser_launcher "$HOME/.local/share/applications/onebridge-browser.desktop"
write_browser_launcher "$HOME/.local/share/applications/chromium.desktop"

# Prefer the proxied browser for http(s) links
if command -v xdg-settings >/dev/null 2>&1; then
  xdg-settings set default-web-browser onebridge-browser.desktop 2>/dev/null || \
    xdg-settings set default-web-browser chromium.desktop 2>/dev/null || true
fi

# Clear Desktop clutter but keep Install Assistant launcher
find "$HOME/Desktop" -mindepth 1 -maxdepth 1 \
  ! -name 'Install Assistant.desktop' \
  -exec rm -rf {} + 2>/dev/null || true

cat > "$HOME/.local/share/applications/onebridge-install-assistant.desktop" <<'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Install Assistant
Comment=Open the Downloads folder
Exec=/bin/bash /opt/bridge/open-install-assistant.sh
Icon=folder-download
Terminal=false
Categories=Utility;
StartupNotify=true
EOF
chmod +x "$HOME/.local/share/applications/onebridge-install-assistant.desktop"

cat > "$HOME/Desktop/Install Assistant.desktop" <<'EOF'
[Desktop Entry]
Version=1.0
Type=Link
Name=Install Assistant
Comment=Open the Downloads folder
Icon=folder-download
URL=application://onebridge-install-assistant.desktop
EOF
chmod +x "$HOME/Desktop/Install Assistant.desktop"
if command -v gio >/dev/null 2>&1; then
  gio set "$HOME/Desktop/Install Assistant.desktop" metadata::trusted true 2>/dev/null || true
fi

# Do not start the old install-assistant Chromium UI server

# Hide XFCE default desktop icons (home / trash / filesystem / removable)
if command -v xfconf-query >/dev/null 2>&1; then
  xfconf-query -c xfce4-desktop -p /desktop-icons/file-icons/show-home -n -t bool -s false 2>/dev/null || \
    xfconf-query -c xfce4-desktop -p /desktop-icons/file-icons/show-home -s false 2>/dev/null || true
  xfconf-query -c xfce4-desktop -p /desktop-icons/file-icons/show-trash -n -t bool -s false 2>/dev/null || \
    xfconf-query -c xfce4-desktop -p /desktop-icons/file-icons/show-trash -s false 2>/dev/null || true
  xfconf-query -c xfce4-desktop -p /desktop-icons/file-icons/show-filesystem -n -t bool -s false 2>/dev/null || \
    xfconf-query -c xfce4-desktop -p /desktop-icons/file-icons/show-filesystem -s false 2>/dev/null || true
  xfconf-query -c xfce4-desktop -p /desktop-icons/file-icons/show-removable -n -t bool -s false 2>/dev/null || \
    xfconf-query -c xfce4-desktop -p /desktop-icons/file-icons/show-removable -s false 2>/dev/null || true
fi

# True if a non-zombie process with this exact name is running for this user.
is_live_proc() {
  local name="$1"
  local pid state
  for pid in $(pgrep -u "$(id -u)" -x "$name" 2>/dev/null || true); do
    state="$(ps -o state= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
    if [[ -n "$state" && "$state" != "Z" ]]; then
      return 0
    fi
  done
  return 1
}

# Start desktop environment (no auto terminal)
if command -v startxfce4 >/dev/null 2>&1; then
  if ! is_live_proc xfce4-session; then
    dbus-launch --exit-with-session startxfce4 >/tmp/xfce.log 2>&1 &
    sleep 3
  fi
elif command -v openbox >/dev/null 2>&1; then
  if ! is_live_proc openbox; then
    openbox-session >/tmp/openbox.log 2>&1 &
    sleep 1
  fi
fi

# Virtual speakers + audio stream to host viewer (ws://host:6082)
if [[ -x /usr/local/bin/start-audio.sh ]]; then
  /usr/local/bin/start-audio.sh >/tmp/start-audio.log 2>&1 || {
    echo "[start-desktop] audio failed — see /tmp/start-audio.log" >&2
    cat /tmp/start-audio.log >&2 || true
  }
fi

# Do NOT auto-open browser / Install Assistant / file manager.
# Desktop starts empty; user opens apps from icons when needed.
rm -f "$HOME/.config/onebridge-browser-opened-this-session" 2>/dev/null || true

# Keep the desktop session helper alive — do NOT relaunch apps
while true; do
  sleep 30
done
