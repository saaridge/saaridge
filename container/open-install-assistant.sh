#!/usr/bin/env bash
# Install Assistant — Install or Uninstall packages on the workspace desktop.
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
DONE_FLAG=/tmp/saaridge-install-done
mkdir -p "$HOME/Downloads"

# Host install APIs go through the bridge (:7331), not control plane (:3847).
# Control plane is host-only; network-lock blocks container → :3847.
BRIDGE_URL="${BRIDGE_URL:-${SAARIDGE_BRIDGE_URL:-http://host.docker.internal:7331}}"
BRIDGE_URL="${BRIDGE_URL%/}"
CRED_FILE="${BRIDGE_CREDENTIALS_FILE:-$HOME/.bridge-credentials}"
if [[ -z "${BRIDGE_TOKEN:-}" && -f "$CRED_FILE" ]]; then
  BRIDGE_TOKEN="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("token",""))' "$CRED_FILE" 2>/dev/null || true)"
fi
PICKER_PY="${SAARIDGE_FILE_PICKER:-/opt/bridge/gtk-file-picker.py}"
LIST_APPS_PY="${SAARIDGE_LIST_APPS:-/opt/bridge/list-workspace-apps.py}"
PROGRESS_PID=""

bridge_curl() {
  # Usage: bridge_curl METHOD PATH [curl -d args...]
  local method="$1"
  local path="$2"
  shift 2
  if [[ -z "${BRIDGE_TOKEN:-}" ]]; then
    echo "[install] missing BRIDGE_TOKEN" >>"$LOG"
    return 1
  fi
  curl -sS --connect-timeout 5 \
    -X "$method" "${BRIDGE_URL}${path}" \
    -H "Authorization: Bearer ${BRIDGE_TOKEN}" \
    -H 'Content-Type: application/json' \
    "$@"
}

echo "[install $(date -Is)] start" >>"$LOG"

cleanup_progress() {
  if [[ -n "${PROGRESS_PID:-}" ]] && kill -0 "$PROGRESS_PID" 2>/dev/null; then
    touch "$DONE_FLAG" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$PROGRESS_PID" 2>/dev/null || break
      sleep 0.05
    done
    kill "$PROGRESS_PID" 2>/dev/null || true
    wait "$PROGRESS_PID" 2>/dev/null || true
  fi
  PROGRESS_PID=""
  rm -f "$DONE_FLAG" 2>/dev/null || true
}
trap cleanup_progress EXIT

notify() {
  local kind="$1"
  local msg="$2"
  cleanup_progress
  if [[ -f "$PICKER_PY" ]] && command -v python3 >/dev/null 2>&1; then
    python3 "$PICKER_PY" "--${kind}" "$msg" 2>>"$LOG" || true
    return 0
  fi
  echo "$msg" >>"$LOG"
}

start_progress() {
  local msg="${1:-Working…}"
  rm -f "$DONE_FLAG" 2>/dev/null || true
  if [[ -f "$PICKER_PY" ]] && command -v python3 >/dev/null 2>&1; then
    python3 "$PICKER_PY" --progress "$msg" >>"$LOG" 2>&1 &
    PROGRESS_PID=$!
  fi
}

choose_action() {
  local out ec
  rm -f /tmp/saaridge-menu-action 2>/dev/null || true
  set +e
  out="$(python3 "$PICKER_PY" --menu 2>>"$LOG")"
  ec=$?
  set -e
  if [[ -z "$out" && -f /tmp/saaridge-menu-action ]]; then
    out="$(cat /tmp/saaridge-menu-action 2>/dev/null || true)"
  fi
  rm -f /tmp/saaridge-menu-action 2>/dev/null || true
  echo "[install] menu out='$out' ec=$ec" >>"$LOG"
  case "$out" in
    install|uninstall)
      printf '%s' "$out"
      return 0
      ;;
  esac
  return 1
}

do_install() {
  local out ec FILE pick_ec
  set +e
  out="$(python3 "$PICKER_PY" --pick "Install" "$HOME/Downloads/" 2>>"$LOG")"
  ec=$?
  set -e
  if [[ -z "$out" && -f /tmp/saaridge-picked-path ]]; then
    out="$(cat /tmp/saaridge-picked-path 2>/dev/null || true)"
    rm -f /tmp/saaridge-picked-path 2>/dev/null || true
  fi
  if [[ -z "$out" ]]; then
    echo "[install] cancelled" >>"$LOG"
    exit 0
  fi
  FILE="$out"
  if [[ ! -e "$FILE" ]]; then
    notify error "That file was not found."
    exit 1
  fi

  local BASE RESP OK NAME ERR local_ec host_ec PAYLOAD HOST_RESP
  BASE="$(basename "$FILE")"
  echo "[install] selected $FILE" >>"$LOG"
  start_progress "Installing ${BASE}…"

  LOCAL_CLIENT="${SAARIDGE_OPS_CLIENT:-/opt/bridge/workspace-ops-client.py}"
  set +e
  # Prefer OS-local install (.deb / .AppImage) — no host bridge required.
  RESP="$(python3 "$LOCAL_CLIENT" install "$FILE" 2>>"$LOG")"
  local_ec=$?
  NEED_HOST=0
  if [[ -n "${RESP:-}" ]]; then
    python3 -c 'import json,sys; raise SystemExit(0 if json.loads(sys.argv[1]).get("needsHost") else 1)' "$RESP" 2>/dev/null && NEED_HOST=1
  fi
  # Fall back to host bridge for assistant zips, or if local helper is down.
  if [[ $NEED_HOST -eq 1 || $local_ec -ne 0 || -z "${RESP:-}" ]]; then
    echo "[install] trying host bridge (need_host=$NEED_HOST local_ec=$local_ec)" >>"$LOG"
    PAYLOAD="$(python3 -c 'import json,sys; print(json.dumps({"path": sys.argv[1]}))' "$FILE")"
    HOST_RESP="$(bridge_curl POST /v1/workspace/install-from-path --max-time 600 -d "$PAYLOAD" 2>>"$LOG")"
    host_ec=$?
    if [[ $host_ec -eq 0 && -n "${HOST_RESP:-}" ]]; then
      RESP="$HOST_RESP"
    elif [[ $NEED_HOST -eq 1 && -z "${HOST_RESP:-}" ]]; then
      RESP='{"ok":false,"error":"This package needs the Saaridge host (assistant zip)."}'
    fi
  fi
  set -e
  echo "[install] response $RESP" >>"$LOG"
  cleanup_progress

  if [[ -z "${RESP:-}" ]]; then
    notify error "Install failed. Is the workspace helper running?"
    exit 1
  fi

  OK="$(python3 -c 'import json,sys
try:
  print("1" if json.loads(sys.argv[1]).get("ok") else "0")
except Exception:
  print("0")' "$RESP" 2>/dev/null || echo 0)"

  if [[ "$OK" == "1" ]]; then
    NAME="$(python3 -c 'import json,sys
try:
  j=json.loads(sys.argv[1]); print(j.get("displayName") or j.get("agentId") or "package")
except Exception:
  print("package")' "$RESP" 2>/dev/null || echo package)"
    notify info "Installed: ${NAME}"
    exit 0
  fi

  ERR="$(python3 -c 'import json,sys
try:
  print(json.loads(sys.argv[1]).get("error") or "Install failed")
except Exception:
  print("Install failed")' "$RESP" 2>/dev/null || echo "Install failed")"
  notify error "$ERR"
  exit 1
}

do_uninstall() {
  local LIST RESP curl_ec PKG NAME OK ERR APPS_JSON COUNT
  set +e
  # Prefer local list (works even when bridge is down); merge with API when available.
  APPS_JSON="$(python3 "$LIST_APPS_PY" 2>>"$LOG" || echo '[]')"
  COUNT="$(python3 -c 'import json,sys; print(len(json.loads(sys.argv[1])))' "$APPS_JSON" 2>/dev/null || echo 0)"
  if [[ "$COUNT" == "0" ]]; then
    LIST="$(bridge_curl GET /v1/workspace/apps --max-time 30 2>>"$LOG")"
    curl_ec=$?
    if [[ $curl_ec -eq 0 && -n "${LIST:-}" ]]; then
      APPS_JSON="$(python3 -c 'import json,sys
try:
  j=json.loads(sys.argv[1]); print(json.dumps(j.get("apps") or []))
except Exception:
  print("[]")' "$LIST" 2>/dev/null || echo '[]')"
      COUNT="$(python3 -c 'import json,sys; print(len(json.loads(sys.argv[1])))' "$APPS_JSON")"
    fi
  fi
  set -e
  if [[ "$COUNT" == "0" ]]; then
    notify info "No applications to uninstall."
    exit 0
  fi

  echo "$APPS_JSON" >/tmp/saaridge-uninstall-apps.json
  rm -f /tmp/saaridge-uninstall-pkg 2>/dev/null || true
  set +e
  PKG="$(python3 "$PICKER_PY" --choose-app "@/tmp/saaridge-uninstall-apps.json" 2>>"$LOG")"
  pick_ec=$?
  set -e
  if [[ -z "$PKG" && -f /tmp/saaridge-uninstall-pkg ]]; then
    PKG="$(cat /tmp/saaridge-uninstall-pkg 2>/dev/null || true)"
  fi
  rm -f /tmp/saaridge-uninstall-apps.json /tmp/saaridge-uninstall-pkg
  if [[ $pick_ec -ne 0 || -z "$PKG" ]]; then
    echo "[uninstall] cancelled" >>"$LOG"
    exit 0
  fi

  echo "[uninstall] package $PKG" >>"$LOG"
  start_progress "Uninstalling ${PKG}…"

  PAYLOAD="$(python3 -c 'import json,sys; print(json.dumps({"package": sys.argv[1]}))' "$PKG")"
  set +e
  RESP="$(bridge_curl POST /v1/workspace/uninstall-app --max-time 300 -d "$PAYLOAD" 2>>"$LOG")"
  curl_ec=$?
  # Fall back to local uninstall when host bridge is unreachable.
  # Do NOT use sudo here — agents must not elevate; host ops go via bridge / ops daemon.
  if [[ $curl_ec -ne 0 || -z "${RESP:-}" ]]; then
    echo "[uninstall] host bridge unreachable (curl_ec=$curl_ec); trying local ops client" >>"$LOG"
    LOCAL_CLIENT="${SAARIDGE_OPS_CLIENT:-/opt/bridge/workspace-ops-client.py}"
    LOCAL_UNINSTALL="${SAARIDGE_UNINSTALL:-/opt/bridge/uninstall-workspace-app.sh}"
    if [[ -x "$LOCAL_CLIENT" || -f "$LOCAL_CLIENT" ]]; then
      RESP="$(python3 "$LOCAL_CLIENT" uninstall "$PKG" 2>>"$LOG")"
      curl_ec=$?
    elif [[ -x "$LOCAL_UNINSTALL" && "$(id -u)" == "0" ]]; then
      RESP="$("$LOCAL_UNINSTALL" "$PKG" 2>>"$LOG")"
      curl_ec=$?
    else
      echo "[uninstall] no non-sudo uninstall path available" >>"$LOG"
      RESP='{"ok":false,"error":"Host bridge unreachable; sudo uninstall is disabled. Retry from Saaridge host."}'
      curl_ec=1
    fi
  fi
  set -e
  echo "[uninstall] curl_ec=$curl_ec response $RESP" >>"$LOG"
  cleanup_progress

  if [[ -z "${RESP:-}" ]]; then
    notify error "Could not reach the uninstall service. Is Saaridge running?"
    exit 1
  fi

  OK="$(python3 -c 'import json,sys
try:
  print("1" if json.loads(sys.argv[1]).get("ok") else "0")
except Exception:
  print("0")' "$RESP" 2>/dev/null || echo 0)"

  if [[ "$OK" == "1" ]]; then
    NAME="$(python3 -c 'import json,sys
try:
  j=json.loads(sys.argv[1]); print(j.get("displayName") or j.get("package") or "app")
except Exception:
  print("app")' "$RESP" 2>/dev/null || echo app)"
    notify info "Uninstalled: ${NAME}"
    exit 0
  fi

  ERR="$(python3 -c 'import json,sys
try:
  print(json.loads(sys.argv[1]).get("error") or "Uninstall failed")
except Exception:
  print("Uninstall failed")' "$RESP" 2>/dev/null || echo "Uninstall failed")"
  notify error "$ERR"
  exit 1
}

if [[ ! -f "$PICKER_PY" ]]; then
  notify error "File picker is not available in this workspace."
  exit 1
fi

set +e
ACTION="$(choose_action)"
action_ec=$?
set -e
if [[ $action_ec -ne 0 || -z "${ACTION:-}" ]]; then
  echo "[install] cancelled at menu" >>"$LOG"
  exit 0
fi

case "$ACTION" in
  install) do_install ;;
  uninstall) do_uninstall ;;
  *) echo "[install] unknown action $ACTION" >>"$LOG"; exit 1 ;;
esac
