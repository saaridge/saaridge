#!/usr/bin/env bash
# Ensure sandbox login profiles remap HOME *after* reading sandbox files.
# Setting HOME=/host/home too early makes bash source /host/home/.bashrc (FUSE hang).
set -euo pipefail

SANDBOX="${ONEBRIDGE_SANDBOX_HOME:-/home/browser}"
PROFILE="${SANDBOX}/.profile"
MARKER="# OneBridge host HOME (must stay last)"

mkdir -p "$SANDBOX"

if [[ -f "$PROFILE" ]] && grep -qF "$MARKER" "$PROFILE" 2>/dev/null; then
  # Refresh block in place
  tmp="$(mktemp)"
  awk -v marker="$MARKER" '
    $0 ~ marker { skip=1; next }
    skip && /^# OneBridge end/ { skip=0; next }
    !skip { print }
  ' "$PROFILE" >"$tmp"
  mv "$tmp" "$PROFILE"
fi

# Force bashrc include to use sandbox path (not $HOME, which we remap later).
if [[ -f "$PROFILE" ]]; then
  sed -i 's|\[ -f "\$HOME/\.bashrc" \]|[ -f /home/browser/.bashrc ]|g' "$PROFILE" 2>/dev/null || true
  sed -i 's|\. "\$HOME/\.bashrc"|. /home/browser/.bashrc|g' "$PROFILE" 2>/dev/null || true
fi

cat >>"$PROFILE" <<'EOF'

# OneBridge host HOME (must stay last)
# Remap only after this sandbox profile finished loading.
export ONEBRIDGE_SANDBOX_HOME="${ONEBRIDGE_SANDBOX_HOME:-/home/browser}"
export ONEBRIDGE_HOST_HOME="${ONEBRIDGE_HOST_HOME:-/host/home}"
export BRIDGE_CREDENTIALS_FILE="${BRIDGE_CREDENTIALS_FILE:-/home/browser/.bridge-credentials}"
export HOME="${ONEBRIDGE_HOST_HOME}"
case ":${PATH}:" in
  *:/opt/bridge/host-bin:*) ;;
  *) export PATH="/opt/bridge/host-bin:${PATH}" ;;
esac
# OneBridge end
EOF

chown browser:browser "$PROFILE" 2>/dev/null || true
chmod 644 "$PROFILE"
echo "[install-sandbox-profile] updated $PROFILE"
