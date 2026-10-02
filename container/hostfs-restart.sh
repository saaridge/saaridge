#!/usr/bin/env bash
# Stop the host-FS watchdog + FUSE mount and start them again.
#
# This lives in its own script on purpose. Doing the same work inline inside
# `docker exec bash -c "...; pkill -f hostfs-watchdog.sh; ..."` is broken: the
# pattern also occurs in that exec's own command line, so pkill SIGTERMs the
# shell (exit 143) and every command after it — including the remount — silently
# never runs. That is how an updated hostfs-watchdog.sh or saaridge-hostfs could
# be copied into the container and then never actually take effect.
#
# This script's argv is just its own path, so the patterns below cannot match it.
set -uo pipefail

MOUNT="${HOSTFS_MOUNT:-/host}"
export HOSTFS_MOUNT="$MOUNT"
export BRIDGE_CREDENTIALS_FILE="${BRIDGE_CREDENTIALS_FILE:-/home/browser/.bridge-credentials}"
export BRIDGE_URL="${BRIDGE_URL:-http://host.docker.internal:7331}"

if [[ -z "${HOSTFS_UID:-}" ]]; then HOSTFS_UID="$(id -u browser 2>/dev/null || echo 1001)"; fi
if [[ -z "${HOSTFS_GID:-}" ]]; then HOSTFS_GID="$(id -g browser 2>/dev/null || echo 1001)"; fi
export HOSTFS_UID HOSTFS_GID

pkill -f 'hostfs-watchdog\.sh' 2>/dev/null || true
pkill -f '/opt/bridge/saaridge-hostfs' 2>/dev/null || true
pkill -f 'hostfs-fuse\.py' 2>/dev/null || true
sleep 1

# A FUSE unmount can block on in-flight STATs, so never let it hang the caller.
timeout 10 fusermount3 -uz "$MOUNT" 2>/dev/null \
  || timeout 10 umount -l "$MOUNT" 2>/dev/null \
  || true
rm -f /tmp/saaridge-hostfs-watchdog.lock /tmp/saaridge-hostfs-fuse.pid 2>/dev/null || true

mkdir -p "$MOUNT" 2>/dev/null || true
nohup /opt/bridge/hostfs-watchdog.sh >/tmp/hostfs-watchdog.log 2>&1 &
echo "WATCHDOG:$!"

# Report readiness so callers can distinguish "restarted" from "still broken".
for _ in $(seq 1 40); do
  if timeout 3 ls "$MOUNT/workspaces" >/dev/null 2>&1; then
    echo MOUNT_READY
    exit 0
  fi
  sleep 0.5
done
echo MOUNT_PENDING
exit 1
