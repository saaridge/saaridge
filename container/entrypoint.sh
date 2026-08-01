#!/usr/bin/env bash
set -euo pipefail

export BRIDGE_URL="${BRIDGE_URL:-http://host.docker.internal:7331}"
export BRIDGE_PROXY_PORT="${BRIDGE_PROXY_PORT:-7332}"
export BROWSER=/opt/bridge/bridge-browser.sh
export PATH="/opt/bridge:${PATH}"
export DISPLAY="${DISPLAY:-:1}"

rm -f /opt/bridge/token

if [[ "$(id -u)" -eq 0 ]]; then
  # Fail-closed: do not continue with open egress if lock cannot be applied.
  /usr/local/bin/network-lock.sh
  mkdir -p /var/run/bridge /host
  if [[ -x /opt/bridge/workspace-ops-daemon.py ]]; then
    pkill -f 'workspace-ops-daemon.py' 2>/dev/null || true
    nohup python3 /opt/bridge/workspace-ops-daemon.py >/tmp/workspace-ops-daemon.log 2>&1 &
  fi
  # Start FUSE hostfs watchdog early; it waits for credentials then mounts /host
  if [[ -x /opt/bridge/hostfs-watchdog.sh ]]; then
    pkill -f 'hostfs-watchdog.sh' 2>/dev/null || true
    pkill -f 'hostfs-fuse.py' 2>/dev/null || true
    nohup /opt/bridge/hostfs-watchdog.sh >/tmp/hostfs-watchdog.log 2>&1 &
  fi
fi

mkdir -p /opt/agents /tmp/agent-scratch /var/run/bridge /home/browser
chown -R root:root /opt/bridge
chmod 755 /opt/bridge
chmod 755 /opt/bridge/bridge-browser.sh /usr/local/bin/start-desktop.sh || true
chmod 644 /opt/bridge/*.mjs 2>/dev/null || true
chown -R browser:browser /home/browser

# dbus for XFCE
if [[ "$(id -u)" -eq 0 ]]; then
  mkdir -p /run/dbus
  if ! pgrep -x dbus-daemon >/dev/null 2>&1; then
    dbus-daemon --system --fork || true
  fi
fi

  if [[ "$(id -u)" -eq 0 ]]; then
  if ! pgrep -x Xvfb >/dev/null 2>&1; then
    # Start with a large virtual screen so RANDR can match any viewer size
    # (laptop / external monitor / resized Electron window). Then shrink to a
    # sensible default; noVNC + resize-display.sh keep it in sync with the pane.
    Xvfb :1 -screen 0 "${RESOLUTION:-3840x2160x24}" -ac +extension RANDR \
      +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
    sleep 0.8
  fi
  # Register modes, then default to 1920x1080 until the viewer syncs its pane size.
  if [[ -x /opt/bridge/ensure-x-modes.sh ]]; then
    DISPLAY=:1 /opt/bridge/ensure-x-modes.sh >/tmp/ensure-x-modes.log 2>&1 || true
  fi
  if [[ -x /opt/bridge/resize-display.sh ]]; then
    DISPLAY=:1 /opt/bridge/resize-display.sh 1920 1080 >/tmp/resize-display-boot.log 2>&1 || true
  fi

  DISPLAY=:1 xsetroot -solid "#1a2f28" 2>/dev/null || true

  # Prefer port liveness over pgrep: a crashed x11vnc can leave a zombie that
  # still matches `pgrep -x x11vnc`, so the watchdog never restarts and :5900 stays down.
  if command -v x11vnc >/dev/null 2>&1 && ! ss -lnt 2>/dev/null | grep -q ':5900 '; then
    # Wheel buttons 4/5 come from noVNC pointer events — keep injection on.
    x11vnc -display :1 -forever -shared -rfbport 5900 -nopw \
      -noncache -modtweak -xkb -noxdamage -noscrollcopyrect \
      -always_inject -xrandr resize \
      >/tmp/x11vnc.log 2>&1 &
    sleep 0.3
  fi

  if command -v websockify >/dev/null 2>&1; then
    pkill -f "websockify --web" 2>/dev/null || true
    sleep 0.2
    websockify --web=/usr/share/novnc 0.0.0.0:6080 localhost:5900 >/tmp/novnc.log 2>&1 &
  fi

  # Audio from container boot: Pulse + :6082 stream, kept alive by watchdog.
  # Must run as browser (Pulse runtime lives under browser's XDG_RUNTIME_DIR).
  chmod 755 /usr/local/bin/start-audio.sh /opt/bridge/audio-watchdog.sh 2>/dev/null || true
  mkdir -p /tmp/runtime-browser /home/browser/.config/pulse
  chown -R browser:browser /tmp/runtime-browser /home/browser/.config/pulse 2>/dev/null || true
  su -s /bin/bash browser -c '
    export HOME=/home/browser DISPLAY=:1
    export XDG_RUNTIME_DIR=/tmp/runtime-browser
    export PULSE_RUNTIME_PATH=/tmp/runtime-browser/pulse
    if [[ -f /tmp/audio-watchdog.pid ]]; then
      kill "$(cat /tmp/audio-watchdog.pid)" 2>/dev/null || true
      rm -f /tmp/audio-watchdog.pid
    fi
    /usr/local/bin/start-audio.sh >/tmp/start-audio.log 2>&1 || true
    setsid /opt/bridge/audio-watchdog.sh </dev/null >/tmp/audio-watchdog.log 2>&1 &
  ' || true

  # Placeholder desktop until host provisions bridge credentials + full session.
  # Do NOT start XFCE here — host provisionDesktopSession owns start-desktop.
  # Starting it in both places races two xfce4-session → duplicate systray
  # ("notification area lost selection").
  if [[ -f /home/browser/.bridge-credentials ]]; then
    su -s /bin/bash browser -c '
      export HOME=/home/browser DISPLAY=:1
      export BRIDGE_CREDENTIALS_FILE=/home/browser/.bridge-credentials
      export LOCAL_PROXY_PORT="$(python3 -c "import json; print(json.load(open(\"/home/browser/.bridge-credentials\"))[\"localProxyPort\"])")"
      export BRIDGE_TOKEN="$(python3 -c "import json; print(json.load(open(\"/home/browser/.bridge-credentials\"))[\"token\"])")"
      export BRIDGE_PROXY_HOST=host.docker.internal BRIDGE_PROXY_PORT=7332
      if ! ss -lnt 2>/dev/null | grep -q ":${LOCAL_PROXY_PORT} "; then
        nohup node /opt/bridge/auth-proxy.mjs >/tmp/desktop-auth-proxy.log 2>&1 &
      fi
    ' || true
  else
    # Minimal visible desktop until host provisions credentials (no terminal)
    DISPLAY=:1 xsetroot -solid "#1a2f28" 2>/dev/null || true
  fi

  (
    while true; do
      sleep 5
      if ! ss -lnt 2>/dev/null | grep -q ':6080 '; then
        websockify --web=/usr/share/novnc 0.0.0.0:6080 localhost:5900 >/tmp/novnc.log 2>&1 &
      fi
      if ! ss -lnt 2>/dev/null | grep -q ':5900 '; then
        x11vnc -display :1 -forever -shared -rfbport 5900 -nopw \
          -noncache -modtweak -xkb -noxdamage -noscrollcopyrect \
          -always_inject -xrandr resize \
          >/tmp/x11vnc.log 2>&1 &
      fi
      # Keep audio watchdog alive across crashes (pidfile + flock; no pkill -f).
      aw_pid=""
      if [[ -f /tmp/audio-watchdog.pid ]]; then
        aw_pid="$(cat /tmp/audio-watchdog.pid 2>/dev/null || true)"
      fi
      if [[ -z "$aw_pid" ]] || ! kill -0 "$aw_pid" 2>/dev/null; then
        chmod 755 /usr/local/bin/start-audio.sh /opt/bridge/audio-watchdog.sh 2>/dev/null || true
        rm -f /tmp/audio-watchdog.pid /tmp/audio-watchdog.lock
        su -s /bin/bash browser -c '
          export HOME=/home/browser DISPLAY=:1
          export XDG_RUNTIME_DIR=/tmp/runtime-browser
          export PULSE_RUNTIME_PATH=/tmp/runtime-browser/pulse
          /usr/local/bin/start-audio.sh >/tmp/start-audio.log 2>&1 || true
          setsid /opt/bridge/audio-watchdog.sh </dev/null >/tmp/audio-watchdog.log 2>&1 &
        ' || true
      fi
    done
  ) >/tmp/desktop-watchdog.log 2>&1 &
fi

echo "[entrypoint] display stack up — host will provision full desktop session"
exec sleep infinity
