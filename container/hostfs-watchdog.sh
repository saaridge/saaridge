#!/usr/bin/env bash
# Keep /host FUSE mount alive. Prefers Rust saaridge-hostfs; falls back to Python.
# Intentionally avoids `set -e` so a transient failure cannot kill the loop.
set -u

LOCK_FILE="${HOSTFS_WATCHDOG_LOCK:-/tmp/saaridge-hostfs-watchdog.lock}"
exec 8>"$LOCK_FILE"
if ! flock -n 8; then
  echo "[hostfs-watchdog] another instance already running — exit"
  exit 0
fi

MOUNT="${HOSTFS_MOUNT:-/host}"
CRED="${BRIDGE_CREDENTIALS_FILE:-/home/browser/.bridge-credentials}"
FUSE_PID_FILE="${HOSTFS_PID_FILE:-/tmp/saaridge-hostfs-fuse.pid}"
export BRIDGE_CREDENTIALS_FILE="$CRED"
export BRIDGE_URL="${BRIDGE_URL:-http://host.docker.internal:7331}"
export HOSTFS_MOUNT="$MOUNT"
export HOSTFS_USER="${HOSTFS_USER:-browser}"
export HOSTFS_IPC_PORT="${HOSTFS_IPC_PORT:-7333}"
# FS IPC listens on host loopback only; container uses HTTP Data API (:7331).
export HOSTFS_IPC="${HOSTFS_IPC:-0}"

RUST_BIN="${HOSTFS_RUST_BIN:-/opt/bridge/saaridge-hostfs}"
PY_BIN="${HOSTFS_PY_BIN:-/opt/bridge/hostfs-fuse.py}"

# Invalidation polling must not ride the agent egress proxy. /opt/bridge/host-bin
# can precede /usr/bin on PATH, and that curl shim forces --proxy, which the host
# cannot resolve (host.docker.internal) — invalidation then fails forever.
BRIDGE_CURL="${BRIDGE_CURL:-/usr/bin/curl}"
if [[ ! -x "$BRIDGE_CURL" ]]; then
  BRIDGE_CURL="$(PATH=/usr/bin:/bin type -P curl 2>/dev/null || echo curl)"
fi

# The Rust mount is built into the image, so an image older than the current
# invalidation protocol silently serves stale bytes after a policy change (the
# classic "still shows [EMAIL]" bug). Ask the binary what it supports and prefer
# the Python mount when it predates the feature, instead of failing quietly.
# Grepping the binary for "__saaridge_policy__" is not a valid probe: the Rust
# optimiser folds short literal comparisons into immediates and drops them from
# .rodata, so the string is absent even when the handling is present.
POLICY_INVALIDATE_CAP="policy-invalidate"
# Path the bridge publishes to mean "drop every cached body" (fs-memo.bustAll).
POLICY_INVALIDATE_MARKER="__saaridge_policy__"
rust_supports_policy_invalidate() {
  [[ -x "$RUST_BIN" ]] || return 1
  local caps
  caps="$(timeout 5 "$RUST_BIN" --capabilities 2>/dev/null)" || return 1
  grep -qx "$POLICY_INVALIDATE_CAP" <<<"$caps"
}

USE_RUST=1
if [[ "${HOSTFS_FORCE_PYTHON:-0}" == "1" ]]; then
  USE_RUST=0
elif ! [[ -x "$RUST_BIN" ]]; then
  USE_RUST=0
elif ! rust_supports_policy_invalidate; then
  USE_RUST=0
  echo "[hostfs-watchdog] Rust hostfs does not report ${POLICY_INVALIDATE_CAP} — using Python mount; rebuild the image to restore it"
fi

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

fuse_pids() {
  {
    pgrep -f '/opt/bridge/saaridge-hostfs( |$)' 2>/dev/null || true
    pgrep -f 'python3.*hostfs-fuse\.py' 2>/dev/null || true
  } | sort -u
}

fuse_count() {
  fuse_pids | wc -l | tr -d ' '
}

read_pidfile() {
  if [[ ! -f "$FUSE_PID_FILE" ]]; then
    return 1
  fi
  local pid
  pid="$(tr -d ' \n' <"$FUSE_PID_FILE" 2>/dev/null || true)"
  if [[ -z "$pid" || ! "$pid" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  echo "$pid"
}

pid_alive() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

write_pidfile() {
  echo "$1" >"$FUSE_PID_FILE" 2>/dev/null || true
}

record_live_fuse_pid() {
  local pid
  pid="$(fuse_pids | head -1)"
  if [[ -n "$pid" ]]; then
    write_pidfile "$pid"
  fi
}

clear_pidfile() {
  rm -f "$FUSE_PID_FILE" 2>/dev/null || true
}

kill_fuse_pid() {
  local pid="$1"
  [[ -z "$pid" ]] && return 0
  kill -TERM "$pid" 2>/dev/null || true
  sleep 0.2
  kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
}

# Keep at most one FUSE child. Orphans accumulate when remount races leave
# dead children behind and exhaust container RAM.
prune_fuse_orphans() {
  local keep="${1:-}"
  local pid
  for pid in $(fuse_pids); do
    if [[ -n "$keep" && "$pid" == "$keep" ]] && pid_alive "$pid"; then
      continue
    fi
    echo "[hostfs-watchdog] pruning orphan fuse pid=$pid"
    kill_fuse_pid "$pid"
  done
}

stop_all_fuse() {
  prune_fuse_orphans ""
  clear_pidfile
  fusermount3 -uz "$MOUNT" 2>/dev/null || umount -l "$MOUNT" 2>/dev/null || true
  sleep 0.2
}

start_fuse() {
  reload_token
  if [[ -z "${BRIDGE_TOKEN:-}" ]]; then
    echo "[hostfs-watchdog] no token yet — waiting"
    return 1
  fi

  local recorded
  recorded="$(read_pidfile 2>/dev/null || true)"
  if is_mounted && [[ -n "${recorded:-}" ]] && pid_alive "$recorded"; then
    prune_fuse_orphans "$recorded"
    return 0
  fi

  # Stale child without a live mount — tear down before spawning another.
  if [[ -n "${recorded:-}" ]] && pid_alive "$recorded" && ! is_mounted; then
    echo "[hostfs-watchdog] stale fuse pid=$recorded without mount — restarting"
    kill_fuse_pid "$recorded"
    clear_pidfile
  fi

  local extra
  extra="$(($(fuse_count) - 0))"
  if [[ "$extra" -gt 0 ]]; then
    echo "[hostfs-watchdog] clearing $extra stale fuse process(es)"
    stop_all_fuse
  elif ! is_mounted; then
    fusermount3 -uz "$MOUNT" 2>/dev/null || umount -l "$MOUNT" 2>/dev/null || true
    sleep 0.2
  fi

  local child_pid
  if [[ "$USE_RUST" == "1" ]]; then
    echo "[hostfs-watchdog] starting Rust hostfs on $MOUNT (uid=$HOSTFS_UID gid=$HOSTFS_GID ipc=${HOSTFS_IPC_PORT})"
    nohup "$RUST_BIN" "$MOUNT" >>/tmp/hostfs-fuse.log 2>&1 &
    child_pid=$!
  else
    echo "[hostfs-watchdog] starting Python hostfs on $MOUNT (uid=$HOSTFS_UID gid=$HOSTFS_GID)"
    nohup python3 "$PY_BIN" "$MOUNT" >>/tmp/hostfs-fuse.log 2>&1 &
    child_pid=$!
  fi

  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if is_mounted; then
      record_live_fuse_pid
      prune_fuse_orphans "$(read_pidfile 2>/dev/null || true)"
      echo "[hostfs-watchdog] mount ready (pid=$(read_pidfile 2>/dev/null || echo ?))"
      return 0
    fi
    if ! pid_alive "$child_pid" && ! is_mounted; then
      break
    fi
    sleep 0.5
  done

  # Rust → Python fallback once
  if [[ "$USE_RUST" == "1" ]]; then
    echo "[hostfs-watchdog] Rust mount failed — falling back to Python"
    kill_fuse_pid "$child_pid"
    clear_pidfile
    fusermount3 -uz "$MOUNT" 2>/dev/null || umount -l "$MOUNT" 2>/dev/null || true
    sleep 0.3
    nohup python3 "$PY_BIN" "$MOUNT" >>/tmp/hostfs-fuse.log 2>&1 &
    child_pid=$!
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
      if is_mounted; then
        record_live_fuse_pid
        prune_fuse_orphans "$(read_pidfile 2>/dev/null || true)"
        echo "[hostfs-watchdog] Python mount ready (pid=$(read_pidfile 2>/dev/null || echo ?))"
        return 0
      fi
      if ! pid_alive "$child_pid" && ! is_mounted; then
        break
      fi
      sleep 0.5
    done
  fi

  echo "[hostfs-watchdog] mount did not come up in time"
  return 1
}

echo "[hostfs-watchdog] watching $MOUNT (credentials=$CRED rust=$RUST_BIN)"
EVENTS_SINCE=0
EVENTS_FAILS=0
EVENTS_EPOCH=""
MOUNT_PENDING=0
BROWSE_TICK=0
BROWSE_INTERVAL="${HOSTFS_BROWSE_CHECK_EVERY:-15}" # ~30s at sleep 2
BROWSE_BUDGET="${HOSTFS_BROWSE_BUDGET:-3}"
INVALIDATE_FILE="${HOSTFS_INVALIDATE_FILE:-/tmp/saaridge-fs-invalidate}"
: >"$INVALIDATE_FILE" 2>/dev/null || true

# Mounted-but-wedged detection: listdir+access must finish within budget.
# The access()-per-entry STAT regression hangs here → remount.
browse_liveness_ok() {
  command -v timeout >/dev/null 2>&1 || return 0
  timeout --signal=KILL "$BROWSE_BUDGET" python3 - "$MOUNT" <<'PY' >/dev/null 2>&1
import os, sys
mount = sys.argv[1]
for root in (f"{mount}/home", f"{mount}/workspaces", mount):
    if not os.path.isdir(root):
        continue
    try:
        names = os.listdir(root)
    except OSError:
        sys.exit(1)
    for name in names[:32]:
        try:
            os.access(os.path.join(root, name), os.R_OK)
        except OSError:
            pass
    sys.exit(0)
sys.exit(1)
PY
}

poll_fs_events() {
  reload_token
  if [[ -z "${BRIDGE_TOKEN:-}" ]]; then
    return 0
  fi
  local body nxt rc
  body="$(
    "$BRIDGE_CURL" -sf -m 3 --noproxy '*' \
      -H "Authorization: Bearer ${BRIDGE_TOKEN}" \
      "${BRIDGE_URL%/}/v1/fs/events?since=${EVENTS_SINCE}" 2>/dev/null
  )"
  rc=$?
  if [[ "$rc" -ne 0 ]]; then
    # A dead invalidation channel means stale file content after policy changes.
    # It used to fail silently; surface it (rate-limited) so it is diagnosable.
    EVENTS_FAILS=$((EVENTS_FAILS + 1))
    if [[ "$EVENTS_FAILS" -eq 1 ]] || [[ $((EVENTS_FAILS % 30)) -eq 0 ]]; then
      echo "[hostfs-watchdog] fs/events poll failed (curl rc=$rc, count=$EVENTS_FAILS) — invalidation is stale"
    fi
    return 0
  fi
  if [[ "$EVENTS_FAILS" -gt 0 ]]; then
    echo "[hostfs-watchdog] fs/events poll recovered after $EVENTS_FAILS failure(s)"
    EVENTS_FAILS=0
  fi
  if [[ -z "$body" ]]; then
    return 0
  fi
  local line nxt epoch
  line="$(
    BODY="$body" INV="$INVALIDATE_FILE" PREV_EPOCH="${EVENTS_EPOCH:-}" \
      MARKER="$POLICY_INVALIDATE_MARKER" python3 - <<'PY'
import json, os
body = os.environ.get("BODY") or ""
inv = os.environ.get("INV") or "/tmp/saaridge-fs-invalidate"
prev = os.environ.get("PREV_EPOCH") or ""
marker = os.environ.get("MARKER") or "__saaridge_policy__"
try:
    d = json.loads(body)
except Exception:
    print("0 ")
    raise SystemExit
epoch = str(d.get("epoch") or "")
paths = [e.get("path") for e in (d.get("events") or []) if e.get("path")]
# A restarted bridge may mediate the same bytes differently and its event ids
# start over, so following `since` alone would keep serving pre-restart content.
if prev and epoch and epoch != prev:
    paths.append(marker)
if paths:
    with open(inv, "a", encoding="utf-8") as f:
        for p in paths:
            f.write(p + "\n")
print("%d %s" % (int(d.get("next") or 0), epoch))
PY
  )"
  nxt="${line%% *}"
  epoch="${line#* }"
  if [[ -n "${epoch:-}" ]]; then
    if [[ -n "${EVENTS_EPOCH:-}" ]] && [[ "$epoch" != "$EVENTS_EPOCH" ]]; then
      echo "[hostfs-watchdog] bridge restarted (epoch ${EVENTS_EPOCH} -> ${epoch}) — dropping cached file bodies"
    fi
    EVENTS_EPOCH="$epoch"
  fi
  # Adopt the server's watermark even when it moves backwards. A restarted bridge
  # numbers events from 1 again, so keeping a stale high watermark made every new
  # event look already-seen and invalidation silently stopped arriving.
  if [[ -n "${nxt:-}" ]] && [[ "$nxt" =~ ^[0-9]+$ ]]; then
    EVENTS_SINCE="$nxt"
  fi
  # The mount only drains this file while serving a request, so without a nudge the
  # client's own read is what discovers the invalidation — too late, because the
  # kernel already sized that read from the stale attribute. A readdir of the mount
  # root is three virtual entries and forces the drain now.
  if [[ -s "$INVALIDATE_FILE" ]]; then
    timeout 3 ls "$MOUNT" >/dev/null 2>&1 || true
  fi
}

while true; do
  if [[ ! -f "$CRED" ]]; then
    sleep 3
    continue
  fi

  recorded="$(read_pidfile 2>/dev/null || true)"
  count="$(fuse_count)"

  if is_mounted && [[ -n "${recorded:-}" ]] && pid_alive "$recorded"; then
    MOUNT_PENDING=0
    if [[ "$count" -gt 1 ]]; then
      echo "[hostfs-watchdog] healthy mount but $count fuse children — pruning"
      prune_fuse_orphans "$recorded"
    fi
    poll_fs_events || true
    BROWSE_TICK=$((BROWSE_TICK + 1))
    if [[ "$BROWSE_TICK" -ge "$BROWSE_INTERVAL" ]]; then
      BROWSE_TICK=0
      if ! browse_liveness_ok; then
        echo "[hostfs-watchdog] /host browse exceeded ${BROWSE_BUDGET}s — remounting"
        start_fuse || true
      fi
    fi
  elif [[ -n "${recorded:-}" ]] && pid_alive "$recorded" && ! is_mounted; then
    MOUNT_PENDING=$((MOUNT_PENDING + 1))
    if [[ "$MOUNT_PENDING" -ge 15 ]]; then
      echo "[hostfs-watchdog] fuse alive but mount stalled — remounting"
      MOUNT_PENDING=0
      start_fuse || true
    fi
  else
    MOUNT_PENDING=0
    if [[ "$count" -gt 0 ]]; then
      echo "[hostfs-watchdog] $count orphan fuse process(es) without healthy mount — clearing"
      stop_all_fuse
    fi
    if is_mounted && { [[ -z "${recorded:-}" ]] || ! pid_alive "${recorded:-}"; }; then
      echo "[hostfs-watchdog] fuse process missing — remounting"
      fusermount3 -uz "$MOUNT" 2>/dev/null || umount -l "$MOUNT" 2>/dev/null || true
    elif ! is_mounted; then
      echo "[hostfs-watchdog] mount missing — remounting"
    fi
    start_fuse || true
  fi
  sleep 2
done
