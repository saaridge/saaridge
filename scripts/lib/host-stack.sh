#!/usr/bin/env bash
# Shared host-stack helpers for Saaridge (launch-mac + Electron + start-host).
# shellcheck shell=bash

SAARIDGE_ROOT="${SAARIDGE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SAARIDGE_CONTROL_URL="${SAARIDGE_CONTROL_URL:-http://127.0.0.1:3847}"
SAARIDGE_HOST_LOG="${SAARIDGE_HOST_LOG:-/tmp/saaridge-host.log}"
SAARIDGE_HOST_PIDFILE="${SAARIDGE_HOST_PIDFILE:-/tmp/saaridge-host.pid}"
SAARIDGE_HOST_LOCKDIR="${SAARIDGE_HOST_LOCKDIR:-/tmp/saaridge-host.lockdir}"
SAARIDGE_SUPERVISOR_LOG="${SAARIDGE_SUPERVISOR_LOG:-/tmp/saaridge-host-supervisor.log}"
SAARIDGE_SUPERVISOR_PIDFILE="${SAARIDGE_SUPERVISOR_PIDFILE:-/tmp/saaridge-host-supervisor.pid}"
SAARIDGE_EXPECTED_CONTAINER="${SAARIDGE_EXPECTED_CONTAINER:-saaridge-box}"

saaridge_control_ok() {
  curl -sf --connect-timeout 1 --max-time 2 \
    "${SAARIDGE_CONTROL_URL}/api/health" >/dev/null 2>&1
}

saaridge_modules_ok() {
  local code
  code="$(
    curl -s -o /dev/null -w "%{http_code}" --connect-timeout 1 --max-time 12 \
      "${SAARIDGE_CONTROL_URL}/api/desktop/stream-health" 2>/dev/null || echo 000
  )"
  [[ "$code" == "200" || "$code" == "503" ]]
}

saaridge_supervisor_pids() {
  pgrep -f "start-host\\.sh" 2>/dev/null || true
}

saaridge_kill_all_supervisors() {
  local pid
  saaridge_stop_host_stack
  pkill -f "start-host\\.sh" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8; do
    saaridge_supervisor_pids | grep -q . || break
    while read -r pid; do
      [[ -z "$pid" ]] && continue
      kill "$pid" 2>/dev/null || true
    done < <(saaridge_supervisor_pids)
    sleep 0.15
    pkill -9 -f "start-host\\.sh" 2>/dev/null || true
    sleep 0.1
  done
  saaridge_free_ports
  rm -f "$SAARIDGE_HOST_PIDFILE" "$SAARIDGE_SUPERVISOR_PIDFILE"
  rm -rf "$SAARIDGE_HOST_LOCKDIR"
  sleep 0.3
}

saaridge_brand_ok() {
  local c
  c="$(
    curl -sf --connect-timeout 1 --max-time 2 \
      "${SAARIDGE_CONTROL_URL}/api/health" 2>/dev/null \
      | python3 -c 'import sys,json; print(json.load(sys.stdin).get("brand",{}).get("container",""))' \
      2>/dev/null || true
  )"
  [[ "$c" == "$SAARIDGE_EXPECTED_CONTAINER" ]]
}

saaridge_host_ready() {
  saaridge_control_ok && saaridge_modules_ok && saaridge_brand_ok
}

saaridge_free_ports() {
  if command -v lsof >/dev/null 2>&1; then
    local p pids
    for p in 3847 7331 7332 7333; do
      pids="$(lsof -t -iTCP:"$p" -sTCP:LISTEN 2>/dev/null || true)"
      if [[ -n "${pids}" ]]; then
        # SIGTERM then SIGKILL for stubborn listeners.
        # shellcheck disable=SC2086
        kill ${pids} 2>/dev/null || true
        sleep 0.2
        # shellcheck disable=SC2086
        kill -9 ${pids} 2>/dev/null || true
      fi
    done
  fi
  sleep 0.3
}

saaridge_stop_host_stack() {
  echo "[saaridge] stopping host stack…"
  if [[ -f "$SAARIDGE_SUPERVISOR_PIDFILE" ]]; then
    kill "$(cat "$SAARIDGE_SUPERVISOR_PIDFILE" 2>/dev/null)" 2>/dev/null || true
  fi
  if [[ -f "$SAARIDGE_HOST_PIDFILE" ]]; then
    kill "$(cat "$SAARIDGE_HOST_PIDFILE" 2>/dev/null)" 2>/dev/null || true
  fi
  if [[ -f /tmp/onebridge-host.pid ]]; then
    kill "$(cat /tmp/onebridge-host.pid 2>/dev/null)" 2>/dev/null || true
    rm -f /tmp/onebridge-host.pid
  fi
  pkill -f "${SAARIDGE_ROOT}/scripts/start-host.sh" 2>/dev/null || true
  pkill -f "scripts/start-host.sh" 2>/dev/null || true
  pkill -f "start-host\\.sh" 2>/dev/null || true
  pkill -f "node ${SAARIDGE_ROOT}/host/index.js" 2>/dev/null || true
  pkill -f "node host/index.js" 2>/dev/null || true
  saaridge_free_ports
  rm -f "$SAARIDGE_HOST_PIDFILE" "$SAARIDGE_SUPERVISOR_PIDFILE"
  rm -rf "$SAARIDGE_HOST_LOCKDIR"
  sleep 0.4
}

# mkdir is atomic on macOS/Linux — used instead of flock (not on stock macOS).
saaridge_acquire_supervisor_lock() {
  if mkdir "$SAARIDGE_HOST_LOCKDIR" 2>/dev/null; then
    echo "$$" >"$SAARIDGE_HOST_LOCKDIR/pid"
    return 0
  fi
  local holder
  holder="$(cat "$SAARIDGE_HOST_LOCKDIR/pid" 2>/dev/null || true)"
  if [[ -n "$holder" ]] && kill -0 "$holder" 2>/dev/null; then
    return 1
  fi
  # Stale lockdir
  rm -rf "$SAARIDGE_HOST_LOCKDIR"
  mkdir "$SAARIDGE_HOST_LOCKDIR" 2>/dev/null || return 1
  echo "$$" >"$SAARIDGE_HOST_LOCKDIR/pid"
  return 0
}

saaridge_release_supervisor_lock() {
  local holder
  holder="$(cat "$SAARIDGE_HOST_LOCKDIR/pid" 2>/dev/null || true)"
  if [[ -z "$holder" || "$holder" == "$$" ]]; then
    rm -rf "$SAARIDGE_HOST_LOCKDIR"
  fi
}

saaridge_wait_host_ready() {
  local tries="${1:-90}"
  local i
  for i in $(seq 1 "$tries"); do
    if saaridge_host_ready; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}
