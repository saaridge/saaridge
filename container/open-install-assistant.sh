#!/usr/bin/env bash
# Install Assistant — opens the Downloads folder only.
set -uo pipefail

export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/home/browser}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-browser}"

# Inherit XFCE session bus so Thunar/window manager behave normally
SESSION_PID="$(pgrep -u "$(id -u)" -x xfce4-session | head -1 || true)"
if [[ -n "${SESSION_PID:-}" && -r "/proc/${SESSION_PID}/environ" ]]; then
  while IFS= read -r -d '' entry; do
    case "$entry" in
      DBUS_SESSION_BUS_ADDRESS=*|SESSION_MANAGER=*)
        export "$entry"
        ;;
    esac
  done < "/proc/${SESSION_PID}/environ"
fi

DOWNLOADS="$HOME/Downloads"
mkdir -p "$DOWNLOADS"

LOG=/tmp/open-install-assistant.log
echo "[open-install $(date -Is)] open $DOWNLOADS" >>"$LOG"

if command -v thunar >/dev/null 2>&1; then
  exec thunar "$DOWNLOADS"
elif command -v exo-open >/dev/null 2>&1; then
  exec exo-open "$DOWNLOADS"
elif command -v xdg-open >/dev/null 2>&1; then
  exec xdg-open "$DOWNLOADS"
else
  xmessage "Could not open Downloads folder." 2>>"$LOG" || true
  exit 1
fi
