#!/usr/bin/env bash
# Seed XFCE panel launcher slots so they are not empty placeholders.
#
# Debian's xfce4-panel default.xml (panel-2 dock) lists four launchers
# (terminal, files, browser, app finder) whose .desktop files live under
# /usr/share/applications, but the launcher plugin only loads items from
# $XDG_CONFIG_HOME/xfce4/panel/launcher-<id>/. That directory is never
# created on a fresh session, so every slot renders the generic settings-gear
# fallback.
#
# XFCE config must stay in the Linux sandbox. agent-env remaps HOME to
# /host/home (FUSE); if the panel follows that, it reads the host's leftover
# ~/.config/xfce4 (numeric launcher names that look like phone numbers get
# vaulted to vault://phone-… and the slot stays a gear).
set -uo pipefail

export DISPLAY="${DISPLAY:-:1}"
export HOME="${SAARIDGE_SANDBOX_HOME:-/home/browser}"
export XDG_CONFIG_HOME="${HOME}/.config"
export XDG_CACHE_HOME="${HOME}/.cache"

# xfce4-panel --restart needs the session bus, not a new one.
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

PANEL_DIR="${XDG_CONFIG_HOME}/xfce4/panel"
mkdir -p "$PANEL_DIR"

# plugin-id -> source .desktop (from /etc/xdg/xfce4/panel/default.xml)
seed_launcher() {
  local id="$1"
  local src_name="$2"
  local dest_dir="${PANEL_DIR}/launcher-${id}"
  local src="/usr/share/applications/${src_name}"
  local dest="${dest_dir}/${src_name}"
  mkdir -p "$dest_dir"
  if [[ ! -f "$src" ]]; then
    echo "[panel-launchers] missing $src" >&2
    return 0
  fi
  python3 - "$src" "$dest" <<'PY'
import os, sys
src, dest = sys.argv[1], sys.argv[2]
lines = open(src, encoding="utf-8", errors="replace").read().splitlines()
out = []
for line in lines:
    if line.startswith("Icon="):
        name = line[5:].strip()
        if name and not name.startswith("/"):
            for cand in (
                f"/usr/share/icons/hicolor/48x48/apps/{name}.png",
                f"/usr/share/icons/hicolor/128x128/apps/{name}.png",
                f"/usr/share/pixmaps/{name}.png",
                f"/usr/share/icons/Adwaita/48x48/legacy/{name}.png",
            ):
                if os.path.isfile(cand):
                    line = f"Icon={cand}"
                    break
    out.append(line)
os.makedirs(os.path.dirname(dest), exist_ok=True)
open(dest, "w", encoding="utf-8").write("\n".join(out) + "\n")
os.chmod(dest, 0o755)
PY
}

seed_launcher 17 xfce4-terminal-emulator.desktop
seed_launcher 18 xfce4-file-manager.desktop
seed_launcher 19 xfce4-web-browser.desktop
seed_launcher 20 xfce4-appfinder.desktop

# Persist the stock layout if this session never saved one.
XML_DIR="${XDG_CONFIG_HOME}/xfce4/xfconf/xfce-perchannel-xml"
mkdir -p "$XML_DIR"
if [[ ! -f "${XML_DIR}/xfce4-panel.xml" && -f /etc/xdg/xfce4/panel/default.xml ]]; then
  cp /etc/xdg/xfce4/panel/default.xml "${XML_DIR}/xfce4-panel.xml"
fi

# Point running xfconf at the sandbox files (ignore failures if xfconfd is down).
if command -v xfconf-query >/dev/null 2>&1; then
  xfconf-query -c xfce4-panel -p /plugins/plugin-17/items -n -a \
    -t string -s "xfce4-terminal-emulator.desktop" 2>/dev/null || true
  xfconf-query -c xfce4-panel -p /plugins/plugin-18/items -n -a \
    -t string -s "xfce4-file-manager.desktop" 2>/dev/null || true
  xfconf-query -c xfce4-panel -p /plugins/plugin-19/items -n -a \
    -t string -s "xfce4-web-browser.desktop" 2>/dev/null || true
  xfconf-query -c xfce4-panel -p /plugins/plugin-20/items -n -a \
    -t string -s "xfce4-appfinder.desktop" 2>/dev/null || true
fi

live_panel_pid() {
  local pid state
  for pid in $(pgrep -u "$(id -u)" -x xfce4-panel 2>/dev/null || true); do
    state="$(ps -o state= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
    if [[ -n "$state" && "$state" != "Z" ]]; then
      echo "$pid"
      return 0
    fi
  done
  return 1
}

if live_panel_pid >/dev/null; then
  xfce4-panel --restart >/dev/null 2>&1 || xfce4-panel -r >/dev/null 2>&1 || true
else
  # Zombie or missing: start one copy. Session-owned is preferred; this is the
  # recover path after a failed --restart.
  nohup xfce4-panel --disable-wm-check >/tmp/xfce4-panel.log 2>&1 &
  sleep 0.8
fi

echo PANEL_LAUNCHERS_OK
