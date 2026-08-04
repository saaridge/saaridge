#!/usr/bin/env bash
# Startup / heal probe for mediated /host.
#
# Passes only when:
#   1) hostfs-watchdog is running (starts it if missing)
#   2) /host is a FUSE mount
#   3) a folder listdir + access() sample finishes within HOSTFS_BROWSE_BUDGET
#
# Emits machine-readable phase lines for the desktop boot UI:
#   PHASE<TAB>id<TAB>human message
#
# Env:
#   HOSTFS_READY_TIMEOUT   total wait seconds (default 45)
#   HOSTFS_BROWSE_BUDGET   max seconds for one browse sample (default 3)
#   HOSTFS_MOUNT           mountpoint (default /host)
set -u

MOUNT="${HOSTFS_MOUNT:-/host}"
CRED="${BRIDGE_CREDENTIALS_FILE:-/home/browser/.bridge-credentials}"
TOTAL_TIMEOUT="${HOSTFS_READY_TIMEOUT:-45}"
BROWSE_BUDGET="${HOSTFS_BROWSE_BUDGET:-3}"
PHASE_FILE="${HOSTFS_READY_PHASE_FILE:-/tmp/hostfs-ready.phase}"
LOG_TAG="[hostfs-ready]"

# Always flush so docker-exec stream / boot poller sees phases promptly.
emit_phase() {
  local id="$1"
  local msg="$2"
  printf 'PHASE\t%s\t%s\n' "$id" "$msg"
  printf '%s\t%s\n' "$id" "$msg" >"$PHASE_FILE" 2>/dev/null || true
}

is_mounted() {
  findmnt -T "$MOUNT" 2>/dev/null | grep -q 'fuse' && return 0
  mount 2>/dev/null | grep -q " on ${MOUNT} " && return 0
  return 1
}

watchdog_running() {
  local pid cmd
  for pid in $(ls /proc 2>/dev/null | grep -E '^[0-9]+$' || true); do
    [[ -r "/proc/$pid/cmdline" ]] || continue
    cmd="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
    case "$cmd" in
      *"/opt/bridge/hostfs-watchdog.sh"*) return 0 ;;
    esac
  done
  return 1
}

ensure_watchdog() {
  if watchdog_running; then
    return 0
  fi
  if [[ ! -x /opt/bridge/hostfs-watchdog.sh ]]; then
    echo "$LOG_TAG hostfs-watchdog.sh missing" >&2
    return 1
  fi
  emit_phase "hostfs_watchdog" "Starting host drive watchdog…"
  rm -f /tmp/onebridge-hostfs-watchdog.lock 2>/dev/null || true
  nohup env \
    BRIDGE_CREDENTIALS_FILE="$CRED" \
    BRIDGE_URL="${BRIDGE_URL:-http://host.docker.internal:7331}" \
    HOSTFS_MOUNT="$MOUNT" \
    HOSTFS_UID="${HOSTFS_UID:-$(id -u browser 2>/dev/null || echo 1001)}" \
    HOSTFS_GID="${HOSTFS_GID:-$(id -g browser 2>/dev/null || echo 1001)}" \
    /opt/bridge/hostfs-watchdog.sh >>/tmp/hostfs-watchdog.log 2>&1 &
  return 0
}

# Kill only the FUSE child so the watchdog remounts — never pkill -f hostfs
# (that pattern matches helper shells and can kill the watchdog itself).
nudge_remount() {
  emit_phase "hostfs_remount" "Host folders too slow — remounting drive…"
  local pid cmd
  for pid in $(ls /proc 2>/dev/null | grep -E '^[0-9]+$' || true); do
    [[ -r "/proc/$pid/cmdline" ]] || continue
    cmd="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
    case "$cmd" in
      *"python3 /opt/bridge/hostfs-fuse.py"*|*"python3 /opt/bridge/hostfs-fuse.py "*)
        kill -TERM "$pid" 2>/dev/null || true
        ;;
      *"/opt/bridge/onebridge-hostfs "*)
        kill -TERM "$pid" 2>/dev/null || true
        ;;
    esac
  done
  fusermount3 -uz "$MOUNT" 2>/dev/null || umount -l "$MOUNT" 2>/dev/null || true
  rm -f /tmp/onebridge-hostfs-fuse.pid 2>/dev/null || true
}

# Exit 0 = browsable within budget; 2 = timed out / too slow; 1 = not ready yet.
browse_ok() {
  if ! is_mounted; then
    return 1
  fi
  emit_phase "hostfs_browse" "Checking folders load within ${BROWSE_BUDGET}s…"
  local py
  py="$(cat <<'PY'
import os, sys, time
budget = float(os.environ.get("HOSTFS_BROWSE_BUDGET", "3"))
mount = os.environ.get("HOSTFS_MOUNT", "/host")
t0 = time.time()
deadline = t0 + budget
candidates = [f"{mount}/home", f"{mount}/workspaces", mount]
root = next((r for r in candidates if os.path.isdir(r)), None)
if not root:
    sys.exit(1)
try:
    names = os.listdir(root)
except OSError:
    sys.exit(1)
checked = 0
for name in names[:48]:
    if time.time() > deadline:
        sys.exit(2)
    try:
        os.access(os.path.join(root, name), os.R_OK)
    except OSError:
        pass
    checked += 1
print(f"browse_ok root={root} entries={len(names)} checked={checked} sec={time.time()-t0:.3f}")
sys.exit(0)
PY
)"
  if command -v timeout >/dev/null 2>&1; then
    timeout --signal=KILL "$BROWSE_BUDGET" env \
      HOSTFS_BROWSE_BUDGET="$BROWSE_BUDGET" HOSTFS_MOUNT="$MOUNT" \
      python3 -c "$py"
  else
    HOSTFS_BROWSE_BUDGET="$BROWSE_BUDGET" HOSTFS_MOUNT="$MOUNT" python3 -c "$py"
  fi
  local rc=$?
  if [[ "$rc" -eq 124 || "$rc" -eq 137 ]]; then
    return 2
  fi
  return "$rc"
}

emit_phase "hostfs_start" "Preparing host drive checks…"
ensure_watchdog || {
  emit_phase "hostfs_error" "Host drive watchdog missing"
  exit 1
}

deadline=$((SECONDS + TOTAL_TIMEOUT))
nudged=0
while (( SECONDS < deadline )); do
  if [[ ! -f "$CRED" ]]; then
    emit_phase "hostfs_credentials" "Waiting for bridge credentials…"
    sleep 1
    continue
  fi
  ensure_watchdog || true
  if ! is_mounted; then
    emit_phase "hostfs_mount" "Waiting for /host FUSE mount…"
    sleep 1
    continue
  fi
  emit_phase "hostfs_mount" "Host drive mounted — probing folders…"
  browse_ok
  rc=$?
  if [[ "$rc" -eq 0 ]]; then
    emit_phase "hostfs_ready" "Host drive folders respond within ${BROWSE_BUDGET}s"
    echo "$LOG_TAG /host ready (browse within ${BROWSE_BUDGET}s)"
    exit 0
  fi
  if [[ "$rc" -eq 2 && "$nudged" -eq 0 ]]; then
    nudged=1
    nudge_remount
    sleep 2
    continue
  fi
  emit_phase "hostfs_browse" "Folder browse not ready yet — retrying…"
  sleep 1
done

emit_phase "hostfs_error" "Host drive not browsable within ${TOTAL_TIMEOUT}s"
echo "$LOG_TAG FAILED: /host not browsable within ${TOTAL_TIMEOUT}s (budget=${BROWSE_BUDGET}s)" >&2
exit 1
