#!/usr/bin/env bash
# Point /usr/bin/{uname,hostname,whoami} at host identity shims so absolute
# /usr/bin/uname probes (common in agent toolchains) cannot report linuxkit.
# Real binaries kept as *.debian for recovery / packaging.
set -euo pipefail

HOST_BIN="${SAARIDGE_HOST_BIN:-/opt/bridge/host-bin}"
BACKUP_DIR="${SAARIDGE_BIN_BACKUP:-/usr/lib/saaridge/bin-debian}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "[install-host-identity-bins] need root" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR" "$HOST_BIN"

install_shim() {
  local name="$1"
  local dest="/usr/bin/${name}"
  local shim="${HOST_BIN}/${name}"
  if [[ ! -x "$shim" ]]; then
    echo "[install-host-identity-bins] missing shim $shim" >&2
    return 1
  fi
  if [[ -e "$dest" && ! -L "$dest" ]]; then
    if [[ ! -e "${BACKUP_DIR}/${name}" ]]; then
      cp -a "$dest" "${BACKUP_DIR}/${name}"
    fi
  fi
  # Atomic replace with a tiny wrapper (survives if host-bin is updated later).
  local tmp
  tmp="$(mktemp)"
  cat >"$tmp" <<EOF
#!/bin/bash
exec ${shim} "\$@"
EOF
  chmod 755 "$tmp"
  mv -f "$tmp" "$dest"
  # Also cover /bin/$name when it is a separate file (not the same inode as /usr/bin).
  if [[ -e "/bin/${name}" ]] && ! [[ "/bin/${name}" -ef "$dest" ]]; then
    if [[ ! -e "${BACKUP_DIR}/bin-${name}" && ! -L "/bin/${name}" ]]; then
      cp -a "/bin/${name}" "${BACKUP_DIR}/bin-${name}" 2>/dev/null || true
    fi
    ln -sfn "$dest" "/bin/${name}"
  fi
  echo "[install-host-identity-bins] ${dest} → ${shim}"
}

install_shim uname
install_shim hostname
install_shim whoami
