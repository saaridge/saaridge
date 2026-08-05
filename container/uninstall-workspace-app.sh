#!/usr/bin/env bash
# Uninstall a workspace app locally (dpkg purge / AppImage remove + desktop cleanup).
# Intended to run as root (via sudo from Install Assistant when control plane is down).
set -euo pipefail

PKG="${1:-}"
if [[ -z "$PKG" ]] || [[ "$PKG" == *..* ]] || [[ "$PKG" == */* ]]; then
  echo '{"ok":false,"error":"Invalid package"}'
  exit 1
fi
# Reject control characters / whitespace-only
case "$PKG" in
  *[[:space:]]*|*[\'\"]*)
    echo '{"ok":false,"error":"Invalid package"}'
    exit 1
    ;;
esac

export HOME=/home/browser
export DEBIAN_FRONTEND=noninteractive
DISPLAY="${DISPLAY:-:1}"

cleanup_launchers() {
  local pkg="$1"
  python3 - "$pkg" <<'PY'
import glob, os, sys
pkg = sys.argv[1]
paths = (
    glob.glob("/home/browser/Desktop/*.desktop")
    + glob.glob("/home/browser/.local/share/applications/*.desktop")
)
for path in paths:
    try:
        text = open(path, encoding="utf-8", errors="replace").read()
    except OSError:
        continue
    if f"X-Saaridge-Package={pkg}" in text or (
        pkg == "cursor" and "Name=Cursor" in text and "X-Saaridge-Package=" in text
    ):
        try:
            os.remove(path)
            print("removed", path, file=sys.stderr)
        except OSError:
            pass
PY
  if [[ -f /opt/bridge/record-workspace-package.py ]]; then
    su -s /bin/bash browser -c "python3 /opt/bridge/record-workspace-package.py remove $(printf %q "$pkg")" 2>/dev/null || true
  fi
  chown -R browser:browser /home/browser/Desktop /home/browser/.local/share/applications /home/browser/.local/share/saaridge 2>/dev/null || true
  if pgrep -x xfdesktop >/dev/null 2>&1; then
    su -s /bin/bash browser -c "export DISPLAY=${DISPLAY}; xfdesktop --reload" 2>/dev/null || true
  fi
}

if [[ "$PKG" == appimage:* ]]; then
  NAME="${PKG#appimage:}"
  rm -f "/home/browser/Applications/${NAME}.AppImage" \
        "/home/browser/Applications/${NAME}.appimage" \
        "/home/browser/Applications/${NAME}" 2>/dev/null || true
  cleanup_launchers "$PKG"
  python3 -c 'import json,sys; print(json.dumps({"ok":True,"displayName":sys.argv[1],"package":sys.argv[2]}))' "$NAME" "$PKG"
  exit 0
fi

set +e
OUT="$(dpkg --purge "$PKG" 2>&1 || apt-get remove -y --purge "$PKG" 2>&1)"
CODE=$?
set -e
echo "$OUT" >&2

cleanup_launchers "$PKG"

if [[ $CODE -ne 0 ]]; then
  # Treat as success if package is already gone
  if ! dpkg-query -W -f='${Status}' "$PKG" 2>/dev/null | grep -q 'install ok installed'; then
    CODE=0
  fi
fi

if [[ $CODE -ne 0 ]]; then
  python3 -c 'import json,sys; print(json.dumps({"ok":False,"error":(sys.argv[1] or "Uninstall failed")[-500]}))' "$OUT"
  exit 1
fi

python3 -c 'import json,sys; print(json.dumps({"ok":True,"displayName":sys.argv[1],"package":sys.argv[1]}))' "$PKG"
exit 0
