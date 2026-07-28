#!/usr/bin/env bash
# Restart workspace Chromium with Pulse wired (safe: no pkill -f self-match).
set -uo pipefail

export HOME="${HOME:-/home/browser}"
export DISPLAY="${DISPLAY:-:1}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-browser}"
export PULSE_RUNTIME_PATH="${PULSE_RUNTIME_PATH:-$XDG_RUNTIME_DIR/pulse}"
export PULSE_SERVER="${PULSE_SERVER:-unix:${PULSE_RUNTIME_PATH}/native}"
export BRIDGE_CREDENTIALS_FILE="${BRIDGE_CREDENTIALS_FILE:-$HOME/.bridge-credentials}"

URL="${1:-https://www.youtube.com}"
PROFILE="$HOME/chromium-bridge-profile"

# Exact-name kills only — never pkill -f with a pattern that appears in this script's argv.
pkill -u "$(id -u)" -x chromium 2>/dev/null || true
# Reap leftover chrome helper names used on Debian
pkill -u "$(id -u)" -x chrome 2>/dev/null || true
sleep 0.8
rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonCookie" "$PROFILE/SingletonSocket" 2>/dev/null || true

if [[ -x /usr/local/bin/start-audio.sh ]]; then
  /usr/local/bin/start-audio.sh >/tmp/start-audio-from-browser.log 2>&1 || true
fi

nohup /opt/bridge/launch-browser.sh "$URL" >/tmp/chromium-desktop.log 2>&1 &
for _ in $(seq 1 40); do
  # Ignore zombie leftovers from earlier kills
  if ps -u "$(id -u)" -o state=,comm= 2>/dev/null | awk '$1 != "Z" && $2 == "chromium" { found=1 } END { exit !found }'; then
    echo OPENED
    exit 0
  fi
  sleep 0.25
done
echo FAIL
tail -30 /tmp/chromium-desktop.log 2>/dev/null || true
exit 1
