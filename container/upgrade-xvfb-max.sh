#!/usr/bin/env bash
# Restart Xvfb with a large max so the desktop can match any viewer size.
# Preserves credentials; restarts VNC + XFCE session helpers.
set -uo pipefail

export DISPLAY=:1

echo "[upgrade-xvfb] stopping display clients"
# Kill live (non-zombie) session pieces carefully by name via python
python3 - <<'PY'
import os, signal, time

def status(pid):
    try:
        with open(f"/proc/{pid}/status") as f:
            for line in f:
                if line.startswith("State:"):
                    return line.split()[1]
    except OSError:
        return "?"
    return "?"

def comm(pid):
    try:
        with open(f"/proc/{pid}/comm") as f:
            return f.read().strip()
    except OSError:
        return ""

def cmdline(pid):
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            return f.read().replace(b"\0", b" ").decode("utf-8", "replace")
    except OSError:
        return ""

targets = {
    "x11vnc", "Xvfb", "xfwm4", "xfce4-panel", "xfdesktop", "xfce4-session",
    "chromium", "thunar",
}
for entry in os.listdir("/proc"):
    if not entry.isdigit():
        continue
    pid = int(entry)
    if status(pid) == "Z":
        continue
    name = comm(pid)
    cmd = cmdline(pid)
    kill = name in targets or (name.startswith("python") and "websockify" in cmd and "--web=" in cmd)
    if kill:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
time.sleep(0.8)
for entry in os.listdir("/proc"):
    if not entry.isdigit():
        continue
    pid = int(entry)
    if status(pid) == "Z":
        continue
    name = comm(pid)
    cmd = cmdline(pid)
    if name in targets or (name.startswith("python") and "websockify" in cmd and "--web=" in cmd):
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
print("stopped")
PY

sleep 0.5
echo "[upgrade-xvfb] starting Xvfb 3840x2160"
Xvfb :1 -screen 0 3840x2160x24 -ac +extension RANDR +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
sleep 1.0

# Seed a normal mode then shrink to 1920x1080 as default until viewer syncs
if [[ -x /opt/bridge/ensure-x-modes.sh ]]; then
  /opt/bridge/ensure-x-modes.sh >/tmp/ensure-x-modes.log 2>&1 || true
fi
/opt/bridge/resize-display.sh 1920 1080 || true

xsetroot -solid "#1a2f28" 2>/dev/null || true

echo "[upgrade-xvfb] starting vnc"
python3 /opt/bridge/restart-vnc-stack.py

echo "[upgrade-xvfb] starting desktop session"
if [[ -f /home/browser/.bridge-credentials ]]; then
  su -s /bin/bash browser -c '
    export HOME=/home/browser DISPLAY=:1
    export BRIDGE_CREDENTIALS_FILE=/home/browser/.bridge-credentials
    export LOCAL_PROXY_PORT="$(python3 -c "import json; print(json.load(open(\"/home/browser/.bridge-credentials\"))[\"localProxyPort\"])")"
    export BRIDGE_TOKEN="$(python3 -c "import json; print(json.load(open(\"/home/browser/.bridge-credentials\"))[\"token\"])")"
    export BRIDGE_PROXY_HOST=host.docker.internal BRIDGE_PROXY_PORT=7332
    export AGENT_ID=workspace-desktop
    source /opt/bridge/agent-env.sh 2>/dev/null || true
    # auth-proxy if missing
    if ! ss -lnt | grep -q ":${LOCAL_PROXY_PORT} "; then
      nohup node /opt/bridge/auth-proxy.mjs >/tmp/desktop-auth-proxy.log 2>&1 &
    fi
    nohup /usr/local/bin/start-desktop.sh >/tmp/desktop.log 2>&1 &
  '
fi

sleep 2
echo "[upgrade-xvfb] done"
DISPLAY=:1 xrandr | head -6
