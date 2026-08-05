#!/usr/bin/env bash
# Open a friendly card for an installed assistant (desktop icon target).
set -euo pipefail

AGENT_ID="${1:-}"
AGENT_NAME="${2:-Assistant}"
HTML="/home/browser/.local/share/saaridge/agents/${AGENT_ID}.html"

export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/home/browser}"
export BRIDGE_CREDENTIALS_FILE="${BRIDGE_CREDENTIALS_FILE:-$HOME/.bridge-credentials}"

if [[ -f "$HTML" ]]; then
  exec /opt/bridge/launch-browser.sh "file://${HTML}"
fi

# Fallback dialog
if command -v zenity >/dev/null 2>&1; then
  exec zenity --info --width=420 --title="${AGENT_NAME}" \
    --text="“${AGENT_NAME}” is installed in your secure workspace.\n\nID: ${AGENT_ID}"
fi

exec /opt/bridge/launch-browser.sh "https://www.google.com"
