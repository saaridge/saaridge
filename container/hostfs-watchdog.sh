#!/usr/bin/env bash
# Keep /host FUSE mount alive. Prefers Rust onebridge-hostfs; falls back to Python.
# Intentionally avoids `set -e` so a transient failure cannot kill the loop.
set -u

MOUNT="${HOSTFS_MOUNT:-/host}"
CRED="${BRIDGE_CREDENTIALS_FILE:-/home/browser/.bridge-credentials}"
export BRIDGE_CREDENTIALS_FILE="$CRED"
export BRIDGE_URL="${BRIDGE_URL:-http://host.docker.internal:7331}"
export HOSTFS_MOUNT="$MOUNT"
export HOSTFS_USER="${HOSTFS_USER:-browser}"
export HOSTFS_IPC_PORT="${HOSTFS_IPC_PORT:-7333}"

RUST_BIN="${HOSTFS_RUST_BIN:-/opt/bridge/onebridge-hostfs}"
PY_BIN="${HOSTFS_PY_BIN:-/opt/bridge/hostfs-fuse.py}"

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
  pgrep -f '/opt/bridge/onebridge-hostfs' >/dev/null 2>&1 && return 0
  pgrep -f '/opt/bridge/hostfs-fuse.py' >/dev/null 2>&1 && return 0
  return 1
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

  # Prefer Rust binary when present and executable.
  if [[ -x "$RUST_BIN" ]] && [[ "${HOSTFS_FORCE_PYTHON:-0}" != "1" ]]; then
    echo "[hostfs-watchdog] starting Rust hostfs on $MOUNT (uid=$HOSTFS_UID gid=$HOSTFS_GID ipc=${HOSTFS_IPC_PORT})"
    nohup "$RUST_BIN" "$MOUNT" >>/tmp/hostfs-fuse.log 2>&1 &
  else
    echo "[hostfs-watchdog] starting Python hostfs on $MOUNT (uid=$HOSTFS_UID gid=$HOSTFS_GID)"
    nohup python3 "$PY_BIN" "$MOUNT" >>/tmp/hostfs-fuse.log 2>&1 &
  fi
  # Wait briefly for mount to appear
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if is_mounted && fuse_alive; then
      echo "[hostfs-watchdog] mount ready"
      return 0
    fi
    sleep 0.5
  done
  # If Rust failed to mount, fall back to Python once.
  if [[ -x "$RUST_BIN" ]] && [[ "${HOSTFS_FORCE_PYTHON:-0}" != "1" ]]; then
    echo "[hostfs-watchdog] Rust mount failed — falling back to Python"
    fusermount3 -uz "$MOUNT" 2>/dev/null || umount -l "$MOUNT" 2>/dev/null || true
    pkill -f '/opt/bridge/onebridge-hostfs' 2>/dev/null || true
    sleep 0.3
    nohup python3 "$PY_BIN" "$MOUNT" >>/tmp/hostfs-fuse.log 2>&1 &
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if is_mounted && fuse_alive; then
        echo "[hostfs-watchdog] Python mount ready"
        return 0
      fi
      sleep 0.5
    done
  fi
  echo "[hostfs-watchdog] mount did not come up in time"
  return 1
}

echo "[hostfs-watchdog] watching $MOUNT (credentials=$CRED rust=$RUST_BIN)"
EVENTS_SINCE=0
INVALIDATE_FILE="${HOSTFS_INVALIDATE_FILE:-/tmp/onebridge-fs-invalidate}"
: >"$INVALIDATE_FILE" 2>/dev/null || true

poll_fs_events() {
  reload_token
  if [[ -z "${BRIDGE_TOKEN:-}" ]]; then
    return 0
  fi
  local body nxt
  body="$(
    curl -sf -m 3 \
      -H "Authorization: Bearer ${BRIDGE_TOKEN}" \
      "${BRIDGE_URL%/}/v1/fs/events?since=${EVENTS_SINCE}" 2>/dev/null || true
  )"
  if [[ -z "$body" ]]; then
    return 0
  fi
  nxt="$(
    BODY="$body" INV="$INVALIDATE_FILE" python3 - <<'PY'
import json, os
body = os.environ.get("BODY") or ""
inv = os.environ.get("INV") or "/tmp/onebridge-fs-invalidate"
try:
    d = json.loads(body)
except Exception:
    print("0")
    raise SystemExit
paths = [e.get("path") for e in (d.get("events") or []) if e.get("path")]
if paths:
    with open(inv, "a", encoding="utf-8") as f:
        for p in paths:
            f.write(p + "\n")
print(int(d.get("next") or 0))
PY
  )"
  if [[ -n "${nxt:-}" ]] && [[ "$nxt" =~ ^[0-9]+$ ]] && [[ "$nxt" -gt 0 ]]; then
    EVENTS_SINCE="$nxt"
  fi
}

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
  else
    poll_fs_events || true
  fi
  sleep 2
done
