#!/usr/bin/env bash
# Keep /host FUSE mount alive. Remounts if the daemon dies or mount vanishes.
# Intentionally avoids `set -e` so a transient failure cannot kill the loop.
set -u

MOUNT="${HOSTFS_MOUNT:-/host}"
CRED="${BRIDGE_CREDENTIALS_FILE:-/home/browser/.bridge-credentials}"
export BRIDGE_CREDENTIALS_FILE="$CRED"
export BRIDGE_URL="${BRIDGE_URL:-http://host.docker.internal:7331}"
export HOSTFS_MOUNT="$MOUNT"
export HOSTFS_USER="${HOSTFS_USER:-browser}"

# Present files as the desktop user so Electron/GTK dialogs treat them as owned
if [[ -z "${HOSTFS_UID:-}" ]] || [[ -z "${HOSTFS_GID:-}" ]]; then
  if id -u browser >/dev/null 2>&1; then
    export HOSTFS_UID="$(id -u browser)"
    export HOSTFS_GID="$(id -g browser)"
  else
    export HOSTFS_UID="${HOSTFS_UID:-1001}"
    export HOSTFS_GID="${HOSTFS_GID:-1001}"
  fi
fi

reload_token() {
  if [[ -f "$CRED" ]]; then
    export BRIDGE_TOKEN="$(
      python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("token",""))' "$CRED" 2>/dev/null || true
    )"
  fi
}

mkdir -p "$MOUNT" 2>/dev/null || true

is_mounted() {
  findmnt -T "$MOUNT" 2>/dev/null | grep -q 'fuse' && return 0
  mount 2>/dev/null | grep -q " on ${MOUNT} " && return 0
  return 1
}

fuse_alive() {
  pgrep -f '/opt/bridge/hostfs-fuse.py' >/dev/null 2>&1
}

start_fuse() {
  reload_token
  if [[ -z "${BRIDGE_TOKEN:-}" ]]; then
    echo "[hostfs-watchdog] no token yet — waiting"
    return 1
  fi
  if is_mounted && fuse_alive; then
    return 0
  fi
  # Lazy unmount stale mountpoint
  fusermount3 -uz "$MOUNT" 2>/dev/null || umount -l "$MOUNT" 2>/dev/null || true
  sleep 0.3
  echo "[hostfs-watchdog] starting hostfs-fuse on $MOUNT (uid=$HOSTFS_UID gid=$HOSTFS_GID)"
  # Run as root so allow_other works; files owned via FUSE uid/gid mapping
  nohup python3 /opt/bridge/hostfs-fuse.py "$MOUNT" >>/tmp/hostfs-fuse.log 2>&1 &
  # Wait briefly for mount to appear
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if is_mounted && fuse_alive; then
      echo "[hostfs-watchdog] mount ready"
      return 0
    fi
    sleep 0.5
  done
  echo "[hostfs-watchdog] mount did not come up in time"
  return 1
}

echo "[hostfs-watchdog] watching $MOUNT (credentials=$CRED)"
while true; do
  if [[ ! -f "$CRED" ]]; then
    sleep 3
    continue
  fi
  if ! is_mounted || ! fuse_alive; then
    if is_mounted && ! fuse_alive; then
      echo "[hostfs-watchdog] fuse process missing — remounting"
      fusermount3 -uz "$MOUNT" 2>/dev/null || umount -l "$MOUNT" 2>/dev/null || true
    elif ! is_mounted; then
      echo "[hostfs-watchdog] mount missing — remounting"
    fi
    start_fuse || true
  fi
  sleep 5
done
