#!/usr/bin/env bash
# Keep exactly one xfce4-panel: the one owned by xfce4-session.
# Orphan panels (started by repair/start-desktop) steal the notification area.
set -euo pipefail

export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/home/browser}"

session_pid="$(pgrep -u "$(id -u)" -x xfce4-session | head -1 || true)"

dedupe() {
  local keep pid ppid state
  keep=""
  for pid in $(pgrep -u "$(id -u)" -x xfce4-panel 2>/dev/null || true); do
    state="$(ps -o state= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
    [[ "$state" == "Z" ]] && continue
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
    if [[ -n "${session_pid:-}" && "$ppid" == "$session_pid" ]]; then
      keep="$pid"
      break
    fi
  done

  # No session-owned panel yet — keep the first live one (session may adopt later).
  if [[ -z "$keep" ]]; then
    for pid in $(pgrep -u "$(id -u)" -x xfce4-panel 2>/dev/null || true); do
      state="$(ps -o state= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
      [[ "$state" == "Z" ]] && continue
      keep="$pid"
      break
    done
  fi

  for pid in $(pgrep -u "$(id -u)" -x xfce4-panel 2>/dev/null || true); do
    state="$(ps -o state= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
    [[ "$state" == "Z" ]] && continue
    [[ -n "$keep" && "$pid" == "$keep" ]] && continue
    # Prefer killing non-session panels first.
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
    if [[ -n "${session_pid:-}" && "$ppid" != "$session_pid" ]]; then
      kill -9 "$pid" 2>/dev/null || true
    elif [[ -n "$keep" && "$pid" != "$keep" ]]; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  sleep 0.2
}

if [[ -n "${session_pid:-}" ]]; then
  local_i=0
  while [[ $local_i -lt 20 ]]; do
    dedupe
    count="$(pgrep -u "$(id -u)" -x xfce4-panel 2>/dev/null | while read -r p; do
      s="$(ps -o state= -p "$p" 2>/dev/null | tr -d '[:space:]')"
      [[ "$s" != "Z" ]] && echo 1
    done | wc -l | tr -d ' ')"
    [[ "${count:-0}" -le 1 ]] && break
    local_i=$((local_i + 1))
    sleep 0.5
  done
else
  dedupe
fi

exit 0
