#!/usr/bin/env bash
# Personal-computer style desktop: XFCE + browser icon. No terminals.
# Browser opens once at session start; closing it does NOT auto-reopen.
set -euo pipefail

export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/home/browser}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export BRIDGE_CREDENTIALS_FILE="${BRIDGE_CREDENTIALS_FILE:-$HOME/.bridge-credentials}"

# Mediated host projects via /host FUSE
if [[ -f /opt/bridge/agent-env.sh ]]; then
  # shellcheck source=/dev/null
  source /opt/bridge/agent-env.sh
fi
export ONEBRIDGE_PROJECTS="${ONEBRIDGE_PROJECTS:-/host/workspaces/workspace-desktop}"
export CURSOR_PROJECT_DIR="${CURSOR_PROJECT_DIR:-$ONEBRIDGE_PROJECTS}"

mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" \
  "$HOME/Desktop" "$HOME/Downloads" "$HOME/chromium-bridge-profile" \
  "$HOME/.local/share/applications" 2>/dev/null || true

# Wait for FUSE /host (watchdog may still be mounting after credentials land)
for _ in $(seq 1 60); do
  if [[ -d /host/workspaces ]] || findmnt -T /host 2>/dev/null | grep -q fuse; then
    break
  fi
  sleep 0.5
done
mkdir -p "$ONEBRIDGE_PROJECTS" 2>/dev/null || true

# Host machine label for Places / Desktop (from credentials → agent-env)
ONEBRIDGE_HOST_NAME="${ONEBRIDGE_HOST_NAME:-Host}"
ONEBRIDGE_HOST_HOME="${ONEBRIDGE_HOST_HOME:-/host/home}"

# Host home only in Places / home links (RO via Data API). Drop legacy Projects/Host entries.
rm -f "$HOME/Projects" "$HOME/Host Home" "$HOME/host-home" \
  "$HOME/Desktop/Host Projects" "$HOME/Desktop/Host-Projects" 2>/dev/null || true
if [[ -d /host/home ]]; then
  ln -sfn /host/home "$HOME/${ONEBRIDGE_HOST_NAME} Home" 2>/dev/null || true
  mkdir -p "$HOME/.config/gtk-3.0" 2>/dev/null || true
  echo "file:///host/home ${ONEBRIDGE_HOST_NAME} Home" > "$HOME/.config/gtk-3.0/bookmarks"
fi

# Point Cursor launchers at the mediated host workspace (also covers late installs)
_cursor_exec_line="Exec=/usr/share/cursor/cursor --no-sandbox --disable-gpu --disable-dev-shm-usage \"${CURSOR_PROJECT_DIR}\""
_patch_cursor_desktop() {
  local desk="$1"
  [[ -f "$desk" ]] || return 0
  # Only rewrite the primary [Desktop Entry] Exec= — leave Desktop Action Exec alone
  python3 - "$desk" "$_cursor_exec_line" <<'PY' 2>/dev/null || true
import sys
from pathlib import Path
path = Path(sys.argv[1])
exec_line = sys.argv[2]
text = path.read_text(encoding="utf-8", errors="replace").splitlines()
out = []
in_action = False
main_done = False
for line in text:
    if line.startswith("[Desktop Action"):
        in_action = True
    elif line.startswith("[") and line.endswith("]"):
        in_action = False
    if line.startswith("Exec=") and not in_action and not main_done:
        out.append(exec_line)
        main_done = True
        continue
    out.append(line)
if main_done:
    path.write_text("\n".join(out) + "\n", encoding="utf-8")
PY
}
for _desk in \
  "$HOME/Desktop/Cursor.desktop" \
  "$HOME/.local/share/applications/cursor.desktop" \
  "$HOME/.local/share/applications/Cursor.desktop" \
  "$HOME/.local/share/applications/onebridge-Cursor.desktop" \
  /usr/share/applications/cursor.desktop \
  /usr/share/applications/co.anysphere.cursor.desktop
do
  _patch_cursor_desktop "$_desk"
done


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

# Clear Desktop clutter but keep Install Assistant and any apps we installed
# (tagged with X-OneBridge-Package=). Never wipe user-installed app icons.
mkdir -p "$HOME/Desktop"
find "$HOME/Desktop" -mindepth 1 -maxdepth 1 | while IFS= read -r entry; do
  base="$(basename "$entry")"
  [[ "$base" == "Install Assistant.desktop" ]] && continue
  if [[ -f "$entry" && "$entry" == *.desktop ]] && grep -q '^X-OneBridge-Package=' "$entry" 2>/dev/null; then
    continue
  fi
  rm -rf "$entry"
done

cat > "$HOME/.local/share/applications/onebridge-install-assistant.desktop" <<'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Install Assistant
Comment=Install or uninstall packages
Exec=/bin/bash /opt/bridge/open-install-assistant.sh
Icon=/usr/share/icons/Adwaita/48x48/legacy/system-software-install.png
Terminal=false
Categories=Utility;
StartupNotify=true
EOF
chmod +x "$HOME/.local/share/applications/onebridge-install-assistant.desktop"

# XFCE needs Type=Application + Exec= (application:// links are unsupported).
cat > "$HOME/Desktop/Install Assistant.desktop" <<'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Install Assistant
Comment=Install or uninstall packages
Exec=/bin/bash /opt/bridge/open-install-assistant.sh
Icon=/usr/share/icons/Adwaita/48x48/legacy/system-software-install.png
Terminal=false
Categories=Utility;
StartupNotify=false
EOF
chmod +x "$HOME/Desktop/Install Assistant.desktop"
if command -v gio >/dev/null 2>&1; then
  gio set "$HOME/Desktop/Install Assistant.desktop" metadata::trusted true 2>/dev/null || true
fi

# Host-home shortcut on Desktop (after wipe so it persists); no Host Projects link
rm -f "$HOME/Desktop/Host Projects" "$HOME/Desktop/Host-Projects" 2>/dev/null || true
if [[ -d /host/home ]]; then
  ln -sfn /host/home "$HOME/Desktop/${ONEBRIDGE_HOST_NAME} Home" 2>/dev/null || true
fi
# Refresh GTK Places in case FUSE came up after the earlier block
if [[ -d /host/home ]]; then
  mkdir -p "$HOME/.config/gtk-3.0" 2>/dev/null || true
  echo "file:///host/home ${ONEBRIDGE_HOST_NAME} Home" > "$HOME/.config/gtk-3.0/bookmarks"
fi

# Re-seed desktop icons for apps installed via Install Assistant
# (copies live under ~/.local/share/applications/onebridge-*.desktop).
for app in "$HOME"/.local/share/applications/onebridge-*.desktop; do
  [[ -f "$app" ]] || continue
  case "$(basename "$app")" in
    onebridge-install-assistant.desktop|onebridge-browser.desktop) continue ;;
  esac
  grep -q '^X-OneBridge-Package=' "$app" 2>/dev/null || continue
  name="$(grep -m1 '^Name=' "$app" | sed 's/^Name=//' || true)"
  [[ -z "$name" ]] && continue
  dest="$HOME/Desktop/${name}.desktop"
  cp -f "$app" "$dest"
  chmod +x "$dest"
  if command -v gio >/dev/null 2>&1; then
    gio set "$dest" metadata::trusted true 2>/dev/null || true
  fi
done

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

# Ensure desktop wallpaper + icons (blank black screen means xfdesktop died)
if command -v xsetroot >/dev/null 2>&1; then
  xsetroot -solid "#1a2f28" 2>/dev/null || true
fi
# Refresh pixbuf loader cache so PNG icons work (panel/desktop crash without it)
if [[ -x /usr/lib/aarch64-linux-gnu/gdk-pixbuf-2.0/gdk-pixbuf-query-loaders ]]; then
  /usr/lib/aarch64-linux-gnu/gdk-pixbuf-2.0/gdk-pixbuf-query-loaders --update-cache 2>/dev/null || true
elif [[ -x /usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/gdk-pixbuf-query-loaders ]]; then
  /usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/gdk-pixbuf-query-loaders --update-cache 2>/dev/null || true
fi
if command -v xfconf-query >/dev/null 2>&1; then
  xfconf-query -c xfce4-desktop -p /desktop-icons/style -n -t int -s 2 2>/dev/null || \
    xfconf-query -c xfce4-desktop -p /desktop-icons/style -s 2 2>/dev/null || true
  xfconf-query -c xsettings -p /Net/IconThemeName -n -t string -s Adwaita 2>/dev/null || \
    xfconf-query -c xsettings -p /Net/IconThemeName -s Adwaita 2>/dev/null || true
  for mon in monitor0 monitorVNC-0 monitorscreen; do
    base="/backdrop/screen0/${mon}/workspace0"
    xfconf-query -c xfce4-desktop -p "${base}/image-style" -n -t int -s 0 2>/dev/null || \
      xfconf-query -c xfce4-desktop -p "${base}/image-style" -s 0 2>/dev/null || true
    xfconf-query -c xfce4-desktop -p "${base}/color-style" -n -t int -s 0 2>/dev/null || \
      xfconf-query -c xfce4-desktop -p "${base}/color-style" -s 0 2>/dev/null || true
  done
fi
if ! is_live_proc xfdesktop && command -v xfdesktop >/dev/null 2>&1; then
  nohup xfdesktop >/tmp/xfdesktop.log 2>&1 &
  sleep 0.5
fi
# Panel is started by xfce4-session only — never spawn a second panel here.
if [[ -x /opt/bridge/dedupe-xfce-panel.sh ]]; then
  /opt/bridge/dedupe-xfce-panel.sh >/tmp/dedupe-panel.log 2>&1 || true
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
