#!/usr/bin/env bash
# Ensure Docker is installed and the daemon is running (macOS + Linux).
set -euo pipefail

alert() {
  local msg="$1"
  echo "[onebridge] $msg" >&2
  if [[ "$(uname -s)" == "Darwin" ]] && command -v osascript >/dev/null 2>&1; then
    # Escape for AppleScript string literal
    local as_msg="${msg//\\/\\\\}"
    as_msg="${as_msg//\"/\\\"}"
    osascript -e "display dialog \"${as_msg}\" buttons {\"OK\"} default button \"OK\" with title \"OneBridge\" with icon stop" \
      >/dev/null 2>&1 || true
  fi
}

docker_installed() {
  if command -v docker >/dev/null 2>&1; then
    return 0
  fi
  if [[ "$(uname -s)" == "Darwin" ]]; then
    [[ -d "/Applications/Docker.app" ]] || [[ -d "$HOME/Applications/Docker.app" ]]
    return $?
  fi
  return 1
}

docker_daemon_ok() {
  command -v docker >/dev/null 2>&1 || return 1
  docker info >/dev/null 2>&1
}

start_docker_daemon() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    if [[ -d "/Applications/Docker.app" ]]; then
      echo "[onebridge] starting Docker Desktop…"
      open -a Docker
    elif [[ -d "$HOME/Applications/Docker.app" ]]; then
      echo "[onebridge] starting Docker Desktop…"
      open -a "$HOME/Applications/Docker.app"
    else
      return 1
    fi
    return 0
  fi

  # Linux: try common service managers
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl is-active --quiet docker 2>/dev/null; then
      return 0
    fi
    echo "[onebridge] starting docker service…"
    if command -v sudo >/dev/null 2>&1; then
      sudo systemctl start docker 2>/dev/null || systemctl start docker 2>/dev/null || return 1
    else
      systemctl start docker 2>/dev/null || return 1
    fi
    return 0
  fi
  if command -v service >/dev/null 2>&1; then
    service docker start 2>/dev/null || return 1
    return 0
  fi
  return 1
}

ensure_docker() {
  if ! docker_installed; then
    alert "Docker is not installed. Please install Docker Desktop, then open OneBridge again."
    exit 1
  fi

  # Prefer PATH docker; on macOS Docker.app may exist before CLI is linked.
  if ! command -v docker >/dev/null 2>&1; then
    if [[ -x "/usr/local/bin/docker" ]]; then
      export PATH="/usr/local/bin:$PATH"
    elif [[ -x "/opt/homebrew/bin/docker" ]]; then
      export PATH="/opt/homebrew/bin:$PATH"
    fi
  fi

  if docker_daemon_ok; then
    echo "[onebridge] Docker is running"
    return 0
  fi

  echo "[onebridge] Docker is installed but not running — starting it…"
  if ! start_docker_daemon; then
    alert "Could not start Docker. Please open Docker Desktop manually, wait until it is running, then try again."
    exit 1
  fi

  local i
  for i in $(seq 1 90); do
    if docker_daemon_ok; then
      echo "[onebridge] Docker is ready"
      return 0
    fi
    sleep 1
  done

  alert "Docker did not become ready in time. Open Docker Desktop, wait until it says Running, then try again."
  exit 1
}

# Allow sourcing or direct execution
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  ensure_docker
fi
