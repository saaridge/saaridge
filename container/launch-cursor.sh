#!/usr/bin/env bash
# Launch Cursor with bridge proxy + shared CA env (desktop .desktop files omit env).
# Trust/proxy env comes from agent-env.sh (system+MITM bundle) — do not override
# SSL_CERT_FILE back to the MITM PEM alone (breaks adaptive TUNNEL public certs).
set -euo pipefail

export DISPLAY="${DISPLAY:-:1}"
# Sandbox keeps editor/profile state; agent-facing HOME is the mediated host home.
export SAARIDGE_SANDBOX_HOME="${SAARIDGE_SANDBOX_HOME:-/home/browser}"
export BRIDGE_CREDENTIALS_FILE="${BRIDGE_CREDENTIALS_FILE:-/home/browser/.bridge-credentials}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/home/browser/.config}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/home/browser/.cache}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-/home/browser/.local/share}"
export XDG_STATE_HOME="${XDG_STATE_HOME:-/home/browser/.local/state}"

if [[ -f /opt/bridge/agent-env.sh ]]; then
  # shellcheck source=/dev/null
  source /opt/bridge/agent-env.sh
fi

# After agent-env: keep the Cursor *process* on sandbox HOME.
# Host HOME over FUSE makes Electron/skills/stat storms hang the UI (loading spinner).
# Agent-facing shells still get HOME=/host/home via terminal.integrated.env + profile.
export HOME="${SAARIDGE_SANDBOX_HOME}"
export SAARIDGE_HOST_HOME="${SAARIDGE_HOST_HOME:-/host/home}"

# Electron Chromium network stack: prefer system trust (includes Saaridge MITM CA).
EXTRA_FLAGS=(
  --no-sandbox
  --disable-gpu
  --disable-dev-shm-usage
  --use-system-ca-store
  --user-data-dir="${SAARIDGE_SANDBOX_HOME}/.config/Cursor"
)

PROJECT="${1:-${CURSOR_PROJECT_DIR:-${SAARIDGE_PROJECTS:-/host/workspaces/workspace-desktop}}}"
shift || true

# Never open the sandbox editor home as the agent workspace.
case "$PROJECT" in
  /home/browser|/home/browser/)
    PROJECT="${SAARIDGE_PROJECTS:-/host/workspaces/workspace-desktop}"
    ;;
esac

exec /usr/share/cursor/cursor "${EXTRA_FLAGS[@]}" "$PROJECT" "$@"
