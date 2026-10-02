#!/usr/bin/env bash
# Personal-computer style desktop: XFCE + browser icon. No terminals.
# Browser opens once at session start; closing it does NOT auto-reopen.
set -euo pipefail

export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/home/browser}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export BRIDGE_CREDENTIALS_FILE="${BRIDGE_CREDENTIALS_FILE:-$HOME/.bridge-credentials}"

# Exactly one start-desktop may run. Entrypoint + host used to race and each
# spawn an xfce4-session → two systrays → "notification area lost selection".
LOCK_FILE="${SAARIDGE_DESKTOP_LOCK:-/tmp/saaridge-start-desktop.lock}"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[start-desktop] another instance already running — exit"
  exit 0
fi
echo $$ >"${SAARIDGE_DESKTOP_PIDFILE:-/tmp/saaridge-start-desktop.pid}"

# Mediated host projects via /host FUSE
if [[ -f /opt/bridge/agent-env.sh ]]; then
  # shellcheck source=/dev/null
  source /opt/bridge/agent-env.sh
fi
# XFCE / desktop chrome must keep sandbox home (profiles, Desktop icons).
# Agent-facing shells still get HOME=/host/home via profile.d + Cursor terminal env.
export SAARIDGE_SANDBOX_HOME="${SAARIDGE_SANDBOX_HOME:-/home/browser}"
export SAARIDGE_HOST_HOME="${SAARIDGE_HOST_HOME:-/host/home}"
export HOME="${SAARIDGE_SANDBOX_HOME}"
export XDG_CONFIG_HOME="${HOME}/.config"
export XDG_CACHE_HOME="${HOME}/.cache"
export XDG_DATA_HOME="${HOME}/.local/share"
export BRIDGE_CREDENTIALS_FILE="${BRIDGE_CREDENTIALS_FILE:-$HOME/.bridge-credentials}"
export SAARIDGE_PROJECTS="${SAARIDGE_PROJECTS:-/host/workspaces/workspace-desktop}"
export CURSOR_PROJECT_DIR="${CURSOR_PROJECT_DIR:-$SAARIDGE_PROJECTS}"

mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" \
  "$HOME/Desktop" "$HOME/chromium-bridge-profile" \
  "$HOME/.local/share/applications" 2>/dev/null || true

# Wait for FUSE /host and prove folders browse within a budget (not just mounted).
# Catches the access()-STAT freeze that makes Thunar look like a dead drive.
if [[ -x /opt/bridge/hostfs-ready.sh ]]; then
  HOSTFS_READY_TIMEOUT="${HOSTFS_READY_TIMEOUT:-45}" \
  HOSTFS_BROWSE_BUDGET="${HOSTFS_BROWSE_BUDGET:-3}" \
    /opt/bridge/hostfs-ready.sh >/tmp/hostfs-ready.log 2>&1 \
    || echo "[start-desktop] WARN: /host browse readiness failed — see /tmp/hostfs-ready.log" >&2
else
  for _ in $(seq 1 60); do
    if [[ -d /host/workspaces ]] || findmnt -T /host 2>/dev/null | grep -q fuse; then
      break
    fi
    sleep 0.5
  done
fi
mkdir -p "$SAARIDGE_PROJECTS" 2>/dev/null || true

# Host machine label for Places / Desktop (from credentials → agent-env)
SAARIDGE_HOST_NAME="${SAARIDGE_HOST_NAME:-Host}"
SAARIDGE_HOST_HOME="${SAARIDGE_HOST_HOME:-/host/home}"

# Host-home symlink + Places; keep sandbox home free of tourist folders.
rm -f "$HOME/Projects" "$HOME/Host Home" "$HOME/host-home" \
  "$HOME/Desktop/Host Projects" "$HOME/Desktop/Host-Projects" \
  "$HOME/host-layout.json" 2>/dev/null || true
rm -f "$HOME"/Unknown_*\ Home "$HOME/Desktop"/Unknown_*\ Home 2>/dev/null || true
for _d in Documents Music Pictures Public Templates Videos; do
  if [[ -d "$HOME/$_d" ]] && [[ -z "$(find "$HOME/$_d" -mindepth 1 -maxdepth 1 2>/dev/null | head -1)" ]]; then
    rmdir "$HOME/$_d" 2>/dev/null || true
  fi
done
# Stop xdg-user-dirs from recreating empty Music/Pictures/…
mkdir -p "$HOME/.config" 2>/dev/null || true
printf '%s\n' 'enabled=False' 'filename_encoding=UTF-8' >"$HOME/.config/user-dirs.conf"
if [[ -d /host/home ]]; then
  ln -sfn /host/home "$HOME/${SAARIDGE_HOST_NAME} Home" 2>/dev/null || true
  if [[ -d /host/home/Downloads ]]; then
    if [[ -L "$HOME/Downloads" ]] || [[ ! -e "$HOME/Downloads" ]]; then
      ln -sfn /host/home/Downloads "$HOME/Downloads" 2>/dev/null || true
    elif [[ -d "$HOME/Downloads" ]] && [[ -z "$(find "$HOME/Downloads" -mindepth 1 -maxdepth 1 2>/dev/null | head -1)" ]]; then
      rmdir "$HOME/Downloads" 2>/dev/null || true
      ln -sfn /host/home/Downloads "$HOME/Downloads" 2>/dev/null || true
    fi
  else
    mkdir -p "$HOME/Downloads" 2>/dev/null || true
  fi
  mkdir -p "$HOME/.config/gtk-3.0" 2>/dev/null || true
  echo "file:///host/home ${SAARIDGE_HOST_NAME} Home" > "$HOME/.config/gtk-3.0/bookmarks"
fi

# Point Cursor launchers through launch-cursor.sh (proxy + MITM CA env).
_cursor_exec_line="Exec=/opt/bridge/launch-cursor.sh \"${CURSOR_PROJECT_DIR}\""
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
  "$HOME/.local/share/applications/saaridge-Cursor.desktop" \
  /usr/share/applications/cursor.desktop \
  /usr/share/applications/co.anysphere.cursor.desktop
do
  _patch_cursor_desktop "$_desk"
done

# Keep Cursor from file-watching huge FUSE trees (node_modules/Library) which
# saturates the mediated mount and makes the explorer look empty.
mkdir -p "$HOME/.config/Cursor/User"
python3 - <<'PY' 2>/dev/null || true
import json
import os
from pathlib import Path
path = Path("/home/browser") / ".config/Cursor/User/settings.json"
cur = {}
if path.is_file():
    try:
        cur = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        cur = {}
if not isinstance(cur, dict):
    cur = {}
watcher = cur.get("files.watcherExclude") or {}
if not isinstance(watcher, dict):
    watcher = {}
# Keep in sync with host/bridge/data/agent-fs-excludes.js (exact basenames).
_AGENT_FS = (
    "node_modules", ".npm", ".yarn", ".pnpm-store", ".parcel-cache", ".eslintcache",
    ".next", ".nuxt", ".turbo", ".vercel", ".output", ".svelte-kit",
    "dist", "build", "coverage",
    ".venv", "venv", ".tox", "__pycache__", ".mypy_cache", ".pytest_cache",
    ".ruff_cache", ".eggs", ".ipynb_checkpoints", "htmlcov", ".hypothesis",
    "vendor", ".bundle",
    "target", ".gradle", ".idea", "out", ".bloop", ".metals",
    "Pods", "DerivedData", "xcuserdata", ".swiftpm",
    "bin", "obj", "packages", ".vs",
    ".dart_tool",
    "_build", ".elixir_ls", "deps",
    ".stack-work", "dist-newstyle",
    ".git", ".cache", "Library",
)
watcher.update({f"**/{n}/**": True for n in _AGENT_FS})
watcher.update({
    "**/.git/objects/**": True,
    "**/.git/subtree-cache/**": True,
})
cur["files.watcherExclude"] = watcher
# Hide heavy trees from the explorer so Cursor does not recurse into them
# on open. FUSE also omits these; explicit path open remains possible.
exclude = cur.get("files.exclude") if isinstance(cur.get("files.exclude"), dict) else {}
exclude.update({f"**/{n}": True for n in _AGENT_FS})
cur["files.exclude"] = exclude
search = cur.get("search.exclude") or {}
if not isinstance(search, dict):
    search = {}
search.update({f"**/{n}": True for n in _AGENT_FS})
cur["search.exclude"] = search
cur["search.followSymlinks"] = False
cur["explorer.autoReveal"] = False
cur["explorer.compactFolders"] = True
cur["git.autoRepositoryDetection"] = False
cur["git.detectSubmodules"] = False
cur["git.enabled"] = False
cur["window.restoreWindows"] = "none"
# Nested CONNECT often breaks HTTP/2 bidi; Cursor SSE fallback unblocks agent.
cur["cursor.general.disableHttp2"] = True
_env_proxy = (
    os.environ.get("HTTPS_PROXY")
    or os.environ.get("https_proxy")
    or ""
).strip()
if not _env_proxy:
    port = os.environ.get("LOCAL_PROXY_PORT") or "17999"
    _env_proxy = f"http://127.0.0.1:{port}"
cur["http.proxy"] = _env_proxy
cur["http.proxySupport"] = "override"
cur["http.systemCertificates"] = True
cur["http.experimental.systemCertificatesV2"] = True
# Drop stale backup restore that reopens huge /host trees or sandbox home on launch.
backup = Path("/home/browser") / ".config/Cursor/User/globalStorage/storage.json"
try:
    if backup.is_file():
        data = json.loads(backup.read_text(encoding="utf-8"))
        if isinstance(data, dict) and "backupWorkspaces" in data:
            data["backupWorkspaces"] = {"workspaces": [], "folders": [], "emptyWindows": []}
            backup.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
except Exception:
    pass
path.write_text(json.dumps(cur, indent=2) + "\n", encoding="utf-8")
print("[start-desktop] Cursor lazy-folder settings for FUSE host paths")
PY

# Generic Code-OSS / Electron editor trust: prefer OS CA store (includes Saaridge
# MITM CA). Applies to every ~/.config/*/User/settings.json — not one product.
python3 - <<'PY' 2>/dev/null || true
import json
import os
from pathlib import Path
home = Path("/home/browser")  # sandbox config root (HOME may be remapped to /host/home)
patched = 0
for path in sorted(home.glob(".config/*/User/settings.json")):
    try:
        cur = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        cur = {}
    if not isinstance(cur, dict):
        cur = {}
    changed = False
    if cur.get("http.systemCertificates") is not True:
        cur["http.systemCertificates"] = True
        changed = True
    # VS Code / forks: v2 picks up Linux system CAs more reliably under MITM.
    if cur.get("http.experimental.systemCertificatesV2") is not True:
        cur["http.experimental.systemCertificatesV2"] = True
        changed = True
    if changed:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(cur, indent=2) + "\n", encoding="utf-8")
        patched += 1
# Ensure Cursor User dir exists even on first boot (before first launch).
cursor_settings = home / ".config/Cursor/User/settings.json"
cursor_settings.parent.mkdir(parents=True, exist_ok=True)
try:
    cur = json.loads(cursor_settings.read_text(encoding="utf-8")) if cursor_settings.is_file() else {}
except Exception:
    cur = {}
if not isinstance(cur, dict):
    cur = {}
changed = False
if cur.get("http.systemCertificates") is not True:
    cur["http.systemCertificates"] = True
    changed = True
if cur.get("http.experimental.systemCertificatesV2") is not True:
    cur["http.experimental.systemCertificatesV2"] = True
    changed = True
# Mediated host shell as default terminal (no MCP tool required).
profiles = cur.get("terminal.integrated.profiles.linux")
if not isinstance(profiles, dict):
    profiles = {}
host_home = os.environ.get("SAARIDGE_HOST_HOME") or "/host/home"
sandbox = os.environ.get("SAARIDGE_SANDBOX_HOME") or "/home/browser"
host_env = {
    "HOME": host_home,
    "SAARIDGE_HOST_HOME": host_home,
    "SAARIDGE_SANDBOX_HOME": sandbox,
    "BRIDGE_CREDENTIALS_FILE": f"{sandbox}/.bridge-credentials",
    "PATH": "/opt/bridge/host-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
}
host_profile = {
    "path": "/opt/bridge/host-bin/host-shell",
    "icon": "terminal",
    "env": host_env,
}
if profiles.get("Saaridge Host") != host_profile:
    profiles["Saaridge Host"] = host_profile
    cur["terminal.integrated.profiles.linux"] = profiles
    changed = True
if cur.get("terminal.integrated.defaultProfile.linux") != "Saaridge Host":
    cur["terminal.integrated.defaultProfile.linux"] = "Saaridge Host"
    changed = True
if cur.get("terminal.integrated.automationProfile.linux") != host_profile:
    cur["terminal.integrated.automationProfile.linux"] = host_profile
    changed = True
term_env = cur.get("terminal.integrated.env.linux")
if not isinstance(term_env, dict):
    term_env = {}
if term_env != host_env:
    cur["terminal.integrated.env.linux"] = host_env
    changed = True
if changed:
    cursor_settings.write_text(json.dumps(cur, indent=2) + "\n", encoding="utf-8")
    patched += 1
print(f"[start-desktop] seeded http.systemCertificates on {patched} editor setting file(s)")
PY


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

# Apps menu launcher (Desktop icon written after clutter clear below)
write_browser_launcher "$HOME/.local/share/applications/saaridge-browser.desktop"
write_browser_launcher "$HOME/.local/share/applications/chromium.desktop"

# Prefer the proxied browser for http(s) links
if command -v xdg-settings >/dev/null 2>&1; then
  xdg-settings set default-web-browser saaridge-browser.desktop 2>/dev/null || \
    xdg-settings set default-web-browser chromium.desktop 2>/dev/null || true
fi

# Clear Desktop clutter but keep Install Assistant, Web Browser, and installed apps
# (tagged with X-Saaridge-Package=). Never wipe user-installed app icons.
mkdir -p "$HOME/Desktop"
find "$HOME/Desktop" -mindepth 1 -maxdepth 1 | while IFS= read -r entry; do
  base="$(basename "$entry")"
  [[ "$base" == "Install Assistant.desktop" ]] && continue
  [[ "$base" == "Web Browser.desktop" ]] && continue
  if [[ -f "$entry" && "$entry" == *.desktop ]] && grep -q '^X-Saaridge-Package=' "$entry" 2>/dev/null; then
    continue
  fi
  rm -rf "$entry"
done

# Proxied Chromium on the Desktop (fail-closed via launch-browser.sh → local auth-proxy)
write_browser_launcher "$HOME/Desktop/Web Browser.desktop"
if command -v gio >/dev/null 2>&1; then
  gio set "$HOME/Desktop/Web Browser.desktop" metadata::trusted true 2>/dev/null || true
fi

cat > "$HOME/.local/share/applications/saaridge-install-assistant.desktop" <<'EOF'
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
chmod +x "$HOME/.local/share/applications/saaridge-install-assistant.desktop"

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

# Host-home shortcut on Desktop (after wipe so it persists)
rm -f "$HOME/Desktop/Host Projects" "$HOME/Desktop/Host-Projects" 2>/dev/null || true
rm -f "$HOME/Desktop"/Unknown_*\ Home 2>/dev/null || true
if [[ -d /host/home ]]; then
  ln -sfn /host/home "$HOME/Desktop/${SAARIDGE_HOST_NAME} Home" 2>/dev/null || true
  mkdir -p "$HOME/.config/gtk-3.0" 2>/dev/null || true
  echo "file:///host/home ${SAARIDGE_HOST_NAME} Home" > "$HOME/.config/gtk-3.0/bookmarks"
fi

# Re-seed desktop icons for apps installed via Install Assistant
# (copies live under ~/.local/share/applications/saaridge-*.desktop).
for app in "$HOME"/.local/share/applications/saaridge-*.desktop; do
  [[ -f "$app" ]] || continue
  case "$(basename "$app")" in
    saaridge-install-assistant.desktop|saaridge-browser.desktop) continue ;;
  esac
  grep -q '^X-Saaridge-Package=' "$app" 2>/dev/null || continue
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

# Start desktop environment (no auto terminal). Only one xfce4-session ever.
if command -v startxfce4 >/dev/null 2>&1; then
  # Drop duplicate sessions left by prior races (keep oldest live pid).
  if [[ -x /opt/bridge/dedupe-xfce-panel.sh ]]; then
    /opt/bridge/dedupe-xfce-panel.sh >/tmp/dedupe-panel-pre.log 2>&1 || true
  fi
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
# Default dock launchers have no ~/.config/xfce4/panel/launcher-* files, so every
# slot shows the settings-gear placeholder. Seed them with real .desktop files.
if [[ -x /opt/bridge/ensure-panel-launchers.sh ]]; then
  /opt/bridge/ensure-panel-launchers.sh >/tmp/panel-launchers.log 2>&1 || true
fi

# Virtual speakers + audio stream to host viewer (ws://host:6082), kept alive by watchdog
chmod 755 /usr/local/bin/start-audio.sh /opt/bridge/audio-watchdog.sh 2>/dev/null || true
if [[ -x /usr/local/bin/start-audio.sh ]]; then
  /usr/local/bin/start-audio.sh >/tmp/start-audio.log 2>&1 || {
    echo "[start-desktop] audio failed — see /tmp/start-audio.log" >&2
    cat /tmp/start-audio.log >&2 || true
  }
fi
if [[ -x /opt/bridge/audio-watchdog.sh ]]; then
  if [[ -f /tmp/audio-watchdog.pid ]]; then
    kill "$(cat /tmp/audio-watchdog.pid)" 2>/dev/null || true
    rm -f /tmp/audio-watchdog.pid /tmp/audio-watchdog.lock
  fi
  sleep 0.2
  setsid /opt/bridge/audio-watchdog.sh </dev/null >/tmp/audio-watchdog.log 2>&1 &
  echo "[start-desktop] audio-watchdog pid $!"
fi

# Do NOT auto-open browser / Install Assistant / file manager.
# Desktop starts empty; user opens apps from icons when needed.
rm -f "$HOME/.config/saaridge-browser-opened-this-session" 2>/dev/null || true

# Keep the desktop session helper alive — do NOT relaunch apps
while true; do
  sleep 30
  # Recurring: a wiped ~/.config/xfce4/panel brings the gear placeholders back.
  if [[ -x /opt/bridge/ensure-panel-launchers.sh ]] && \
     [[ ! -f "${XDG_CONFIG_HOME:-$HOME/.config}/xfce4/panel/launcher-17/xfce4-terminal-emulator.desktop" ]]; then
    /opt/bridge/ensure-panel-launchers.sh >/tmp/panel-launchers.log 2>&1 || true
  fi
done
