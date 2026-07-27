#!/usr/bin/env bash
# Source this in every agent / desktop session.
# Forces HTTP(S) through the local auth-proxy (→ host bridge) and prefers
# host-side tools via MCP. Agents should feel like they run on the host.
#
# Usage: source /opt/bridge/agent-env.sh

_CRED="${BRIDGE_CREDENTIALS_FILE:-}"
if [[ -z "$_CRED" || ! -f "$_CRED" ]]; then
  if [[ -f "${HOME:-}/.bridge-credentials" ]]; then
    _CRED="${HOME}/.bridge-credentials"
    export BRIDGE_CREDENTIALS_FILE="$_CRED"
  fi
fi

if [[ -n "$_CRED" && -f "$_CRED" ]]; then
  _PORT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["localProxyPort"])' "$_CRED" 2>/dev/null || true)"
  if [[ -n "${_PORT:-}" ]]; then
    export LOCAL_PROXY_PORT="$_PORT"
    export http_proxy="http://127.0.0.1:${_PORT}"
    export https_proxy="http://127.0.0.1:${_PORT}"
    export HTTP_PROXY="http://127.0.0.1:${_PORT}"
    export HTTPS_PROXY="http://127.0.0.1:${_PORT}"
    export ALL_PROXY="http://127.0.0.1:${_PORT}"
    export all_proxy="http://127.0.0.1:${_PORT}"
  fi
fi

export NO_PROXY="127.0.0.1,localhost,host.docker.internal"
export no_proxy="$NO_PROXY"
export BRIDGE_URL="${BRIDGE_URL:-http://host.docker.internal:7331}"
export BRIDGE_PROXY_HOST="${BRIDGE_PROXY_HOST:-host.docker.internal}"
export BRIDGE_PROXY_PORT="${BRIDGE_PROXY_PORT:-7332}"

# Host-bin shims first: curl/wget always use the bridge proxy
export PATH="/opt/bridge/host-bin:${PATH}"

# Node 22+: honor HTTP(S)_PROXY for fetch (agents that call network in-process)
case " ${NODE_OPTIONS:-} " in
  *" --use-env-proxy "*) ;;
  *) export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--use-env-proxy" ;;
esac

# Pulse (desktop browser audio)
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-browser}"
export PULSE_RUNTIME_PATH="${PULSE_RUNTIME_PATH:-$XDG_RUNTIME_DIR/pulse}"
if [[ -S "${PULSE_RUNTIME_PATH}/native" ]]; then
  export PULSE_SERVER="unix:${PULSE_RUNTIME_PATH}/native"
fi

# Hint for agents: filesystem + privileged network live on the HOST via MCP
export ONEBRIDGE_HOST_VIA="mcp+proxy"
export BROWSER="${BROWSER:-/opt/bridge/bridge-browser.sh}"
