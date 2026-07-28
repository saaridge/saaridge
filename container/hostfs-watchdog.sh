#!/usr/bin/env bash
# Keep /host FUSE mount alive. Remounts if the daemon dies or mount vanishes.
set -euo pipefail

MOUNT="${HOSTFS_MOUNT:-/host}"
CRED="${BRIDGE_CREDENTIALS_FILE:-/home/browser/.bridge-credentials}"
export BRIDGE_CREDENTIALS_FILE="$CRED"
export BRIDGE_URL="${BRIDGE_URL:-http://host.docker.internal:7331}"
export HOSTFS_MOUNT="$MOUNT"

if [[ -f "$CRED" ]]; then
  export BRIDGE_TOKEN="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["token"])' "$CRED" 2>/dev/null || true)"
fi

mkdir -p "$MOUNT"

is_mounted() {
  findmnt -T "$MOUNT" 2>/dev/null | grep -q 'fuse' || mount | grep -q " on ${MOUNT} "
}

start_fuse() {
  if is_mounted; then
    return 0
  fi
  # Lazy unmount stale mountpoint
  fusermount3 -uz "$MOUNT" 2>/dev/null || umount -l "$MOUNT" 2>/dev/null || true
  echo "[hostfs-watchdog] starting hostfs-fuse on $MOUNT"
  # Run as root so allow_other works; files owned via FUSE uid mapping
  nohup python3 /opt/bridge/hostfs-fuse.py "$MOUNT" >/tmp/hostfs-fuse.log 2>&1 &
  sleep 1
}

echo "[hostfs-watchdog] watching $MOUNT (credentials=$CRED)"
while true; do
  if [[ ! -f "$CRED" ]]; then
    sleep 3
    continue
  fi
  if ! is_mounted; then
    start_fuse || true
  elif ! pgrep -f 'hostfs-fuse.py' >/dev/null 2>&1; then
    echo "[hostfs-watchdog] fuse process missing — remounting"
    fusermount3 -uz "$MOUNT" 2>/dev/null || umount -l "$MOUNT" 2>/dev/null || true
    start_fuse || true
  fi
  sleep 5
done
