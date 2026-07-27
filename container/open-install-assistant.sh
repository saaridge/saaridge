#!/usr/bin/env bash
# Install Assistant — native file picker → install the chosen package.
set -uo pipefail

export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/home/browser}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-browser}"

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

LOG=/tmp/open-install-assistant.log
mkdir -p "$HOME/Downloads"

CONTROL_URL="${ONEBRIDGE_CONTROL_URL:-http://host.docker.internal:3847}"

echo "[install $(date -Is)] file picker" >>"$LOG"

if ! command -v zenity >/dev/null 2>&1; then
  zenity --error --text="File picker is not available in this workspace." 2>>"$LOG" || \
    xmessage "File picker is not available." 2>>"$LOG" || true
  exit 1
fi

FILE="$(
  zenity --file-selection \
    --title="Install assistant" \
    --filename="$HOME/" \
    --file-filter="Assistant packages | *.zip *.tgz *.tar.gz *.onebridge" \
    --file-filter="All files | *" \
    2>>"$LOG" || true
)"

if [[ -z "${FILE:-}" ]]; then
  echo "[install] cancelled" >>"$LOG"
  exit 0
fi

if [[ ! -e "$FILE" ]]; then
  zenity --error --text="That file was not found." 2>>"$LOG" || true
  exit 1
fi

echo "[install] selected $FILE" >>"$LOG"

# JSON-escape the path for curl
PAYLOAD="$(python3 -c 'import json,sys; print(json.dumps({"path": sys.argv[1]}))' "$FILE")"
RESP="$(curl -sS -X POST "${CONTROL_URL}/api/agents/install-from-workspace-path" \
  -H 'Content-Type: application/json' \
  -d "$PAYLOAD" 2>>"$LOG" || true)"

echo "[install] response $RESP" >>"$LOG"

OK="$(python3 -c 'import json,sys
try:
  print("1" if json.loads(sys.argv[1]).get("ok") else "0")
except Exception:
  print("0")' "$RESP" 2>/dev/null || echo 0)"

if [[ "$OK" == "1" ]]; then
  NAME="$(python3 -c 'import json,sys
try:
  j=json.loads(sys.argv[1]); print(j.get("displayName") or j.get("agentId") or "Assistant")
except Exception:
  print("Assistant")' "$RESP" 2>/dev/null || echo Assistant)"
  zenity --info --text="Installed: ${NAME}" 2>>"$LOG" || true
  exit 0
fi

ERR="$(python3 -c 'import json,sys
try:
  print(json.loads(sys.argv[1]).get("error") or "Install failed")
except Exception:
  print("Install failed")' "$RESP" 2>/dev/null || echo "Install failed")"
zenity --error --text="$ERR" 2>>"$LOG" || true
exit 1
