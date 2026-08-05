#!/usr/bin/env bash
# Launch Chromium through the bridge proxy (desktop icon / menu).
set -euo pipefail

export DISPLAY="${DISPLAY:-:1}"
# Editor/agent may remap HOME → /host/home; keep Chromium state in the sandbox.
SANDBOX_HOME="${SAARIDGE_SANDBOX_HOME:-/home/browser}"
export HOME="${SANDBOX_HOME}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$SANDBOX_HOME/.config}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$SANDBOX_HOME/.cache}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$SANDBOX_HOME/.local/share}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-browser}"
export PULSE_RUNTIME_PATH="${PULSE_RUNTIME_PATH:-$XDG_RUNTIME_DIR/pulse}"
export PULSE_STATE_PATH="${PULSE_STATE_PATH:-$SANDBOX_HOME/.config/pulse}"
CRED_FILE="${BRIDGE_CREDENTIALS_FILE:-$SANDBOX_HOME/.bridge-credentials}"

if [[ ! -f "$CRED_FILE" ]]; then
  zenity --error --text="Browser is not ready yet. Open Saaridge and click Start workspace." 2>/dev/null \
    || xmessage "Browser is not ready yet. Start the workspace from Saaridge." 2>/dev/null \
    || true
  exit 1
fi

PORT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["localProxyPort"])' "$CRED_FILE")"
PROXY="http://127.0.0.1:${PORT}"
URL="${1:-https://www.google.com}"

# Wait briefly if auth-proxy is still coming up
for _ in $(seq 1 15); do
  if ss -lnt 2>/dev/null | grep -q ":${PORT} "; then
    break
  fi
  sleep 0.3
done

# Pulse must exist before Chromium starts — otherwise YouTube video works with silent audio.
mkdir -p "$PULSE_RUNTIME_PATH" "$PULSE_STATE_PATH"
if [[ -x /usr/local/bin/start-audio.sh ]]; then
  /usr/local/bin/start-audio.sh >/tmp/start-audio-from-browser.log 2>&1 || true
fi
for _ in $(seq 1 20); do
  if [[ -S "${PULSE_RUNTIME_PATH}/native" ]]; then
    break
  fi
  sleep 0.25
done
export PULSE_SERVER="unix:${PULSE_RUNTIME_PATH}/native"
# Persist default server for zygote / utility audio processes.
if [[ ! -f "${PULSE_STATE_PATH}/client.conf" ]]; then
  cat >"${PULSE_STATE_PATH}/client.conf" <<EOF
default-server = unix:${PULSE_RUNTIME_PATH}/native
autospawn = no
EOF
fi

PROFILE_DIR="$SANDBOX_HOME/chromium-bridge-profile"
mkdir -p "$PROFILE_DIR"
# Stale Singleton* from a crashed Chromium makes it look like "no internet"
# (new instance exits immediately). Clear only if no live chromium for this profile.
if ! pgrep -u "$(id -u)" -f "user-data-dir=${PROFILE_DIR}" >/dev/null 2>&1; then
  rm -f "$PROFILE_DIR/SingletonLock" "$PROFILE_DIR/SingletonCookie" \
    "$PROFILE_DIR/SingletonSocket" 2>/dev/null || true
fi

# Auto-allow mic/camera in profile (avoids Chromium's yellow
# "--use-fake-ui-for-media-stream … stability will suffer" banner).
python3 - "$PROFILE_DIR" <<'PY' 2>/dev/null || true
import json, os, sys, time
root = sys.argv[1]
default = os.path.join(root, "Default")
os.makedirs(default, exist_ok=True)
path = os.path.join(default, "Preferences")
try:
    data = json.load(open(path)) if os.path.isfile(path) else {}
except Exception:
    data = {}
if not isinstance(data, dict):
    data = {}
profile = data.setdefault("profile", {})
content = profile.setdefault("content_settings", {})
exceptions = content.setdefault("exceptions", {})
# 1 = allow. Pattern covers https sites used under the bridge proxy.
allow = {
    "last_modified": str(int(time.time() * 1e6)),
    "setting": 1,
}
for kind in ("media_stream_mic", "media_stream_camera", "media_stream"):
    bucket = exceptions.setdefault(kind, {})
    if not isinstance(bucket, dict):
        bucket = {}
        exceptions[kind] = bucket
    bucket["https://*,*"] = dict(allow)
    bucket["http://*,*"] = dict(allow)
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, separators=(",", ":"))
PY

# VNC users rarely see Chromium's mic permission bar; profile allow + autoplay
# covers getUserMedia without the unsupported fake-ui flag banner.
exec /usr/lib/chromium/chromium \
  --disable-dev-shm-usage \
  --disable-gpu \
  --window-size=1280,800 \
  --window-position=40,40 \
  --start-maximized \
  --disable-features=TouchpadOverscrollHistoryNavigation,AudioServiceOutOfProcess \
  --disable-quic \
  --autoplay-policy=no-user-gesture-required \
  --use-system-ca-store \
  --proxy-server="$PROXY" \
  --proxy-bypass-list="<-loopback>;host.docker.internal" \
  --user-data-dir="$PROFILE_DIR" \
  "$URL"
