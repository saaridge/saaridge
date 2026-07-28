#!/usr/bin/env bash
# Keep exactly one xfce4-session and one xfce4-panel (session-owned).
# Duplicate sessions each load systray → XFCE "notification area lost selection".
set -euo pipefail

export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/home/browser}"

uid="$(id -u)"

live_pids() {
  local name="$1"
  local pid state
  for pid in $(pgrep -u "$uid" -x "$name" 2>/dev/null || true); do
    state="$(ps -o state= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
    if [[ -n "$state" && "$state" != "Z" ]]; then
      echo "$pid"
    fi
  done
}

# Prefer the session that already parents a panel; else oldest pid.
pick_keep_session() {
  local pid ppid panel_ppids keep=""
  panel_ppids=""
  for pid in $(live_pids xfce4-panel); do
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
    panel_ppids="${panel_ppids} ${ppid}"
  done
  for pid in $(live_pids xfce4-session); do
    if [[ " ${panel_ppids} " == *" ${pid} "* ]]; then
      echo "$pid"
      return 0
    fi
  done
  live_pids xfce4-session | head -1
}

dedupe_sessions() {
  local keep pid
  keep="$(pick_keep_session || true)"
  [[ -z "${keep:-}" ]] && return 0
  for pid in $(live_pids xfce4-session); do
    if [[ "$pid" != "$keep" ]]; then
      echo "[dedupe] killing extra xfce4-session pid=$pid (keep=$keep)" >&2
      # Kill session tree gently then hard (panel/wrappers come along).
      kill "$pid" 2>/dev/null || true
      sleep 0.3
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  sleep 0.3
}

dedupe_panels() {
  local keep pid ppid state session_pid
  session_pid="$(live_pids xfce4-session | head -1 || true)"
  keep=""
  for pid in $(live_pids xfce4-panel); do
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
    if [[ -n "${session_pid:-}" && "$ppid" == "$session_pid" ]]; then
      keep="$pid"
      break
    fi
  done
  if [[ -z "$keep" ]]; then
    keep="$(live_pids xfce4-panel | head -1 || true)"
  fi
  for pid in $(live_pids xfce4-panel); do
    [[ -n "$keep" && "$pid" == "$keep" ]] && continue
    echo "[dedupe] killing extra xfce4-panel pid=$pid (keep=${keep:-none})" >&2
    kill -9 "$pid" 2>/dev/null || true
  done
  # Orphan plugin wrappers whose panel parent is gone
  sleep 0.2
  for pid in $(pgrep -u "$uid" -f '/xfce4/panel/wrapper' 2>/dev/null || true); do
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
    if [[ -z "$ppid" || "$ppid" == "1" ]]; then
      kill -9 "$pid" 2>/dev/null || true
      continue
    fi
    if ! kill -0 "$ppid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
}

dedupe_sessions
local_i=0
while [[ $local_i -lt 15 ]]; do
  dedupe_panels
  count="$(live_pids xfce4-panel | wc -l | tr -d ' ')"
  sess="$(live_pids xfce4-session | wc -l | tr -d ' ')"
  [[ "${count:-0}" -le 1 && "${sess:-0}" -le 1 ]] && break
  # Extra session may have respawned a panel — kill sessions again.
  if [[ "${sess:-0}" -gt 1 ]]; then
    dedupe_sessions
  fi
  local_i=$((local_i + 1))
  sleep 0.4
done

exit 0
