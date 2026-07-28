#!/usr/bin/env bash
# Install a .deb or .AppImage into the workspace OS (desktop icon + package record).
# Runs as root via the workspace-ops daemon.
set -euo pipefail

FILE="${1:-}"
if [[ -z "$FILE" ]]; then
  echo '{"ok":false,"error":"No file path"}'
  exit 1
fi
if [[ ! -f "$FILE" ]]; then
  echo '{"ok":false,"error":"File not found"}'
  exit 1
fi
REAL="$(readlink -f "$FILE" 2>/dev/null || echo "$FILE")"
case "$REAL" in
  /home/browser/*|/tmp/*|/var/tmp/*) ;;
  *)
    echo '{"ok":false,"error":"Pick a file inside the workspace filesystem"}'
    exit 1
    ;;
esac

export HOME=/home/browser
export DEBIAN_FRONTEND=noninteractive
export DISPLAY="${DISPLAY:-:1}"
BASE="$(basename "$REAL")"
LOWER="$(echo "$BASE" | tr '[:upper:]' '[:lower:]')"

install_deb() {
  local OUT CODE PKG ICON_LINE DISPLAY_NAME DESKTOP_ICON
  set +e
  OUT="$(dpkg -i "$REAL" 2>&1)"
  CODE=$?
  echo "$OUT" >&2
  if [[ $CODE -ne 0 ]]; then
    apt-get install -y -f -qq >&2 || true
    OUT="$(dpkg -i "$REAL" 2>&1)"
    CODE=$?
    echo "$OUT" >&2
  fi
  set -e
  if [[ $CODE -ne 0 ]]; then
    python3 -c 'import json,sys; print(json.dumps({"ok":False,"error":(sys.argv[1] or "dpkg failed")[-800]}))' "$OUT"
    exit 1
  fi

  PKG="$(dpkg-deb -f "$REAL" Package 2>/dev/null || true)"
  ICON_LINE="$(
    su -s /bin/bash browser -c \
      "export HOME=/home/browser DISPLAY=:1; python3 /opt/bridge/ensure-desktop-icon.py $(printf %q "${PKG:-}") $(printf %q "$BASE")" \
      2>/dev/null || true
  )"
  DISPLAY_NAME="${PKG:-}"
  DESKTOP_ICON=""
  if [[ "$ICON_LINE" == OK\|* ]]; then
    DISPLAY_NAME="$(echo "$ICON_LINE" | cut -d'|' -f2)"
    DESKTOP_ICON="$DISPLAY_NAME"
  fi
  [[ -z "$DISPLAY_NAME" ]] && DISPLAY_NAME="${BASE%.deb}"

  if [[ -n "$PKG" && -f /opt/bridge/record-workspace-package.py ]]; then
    su -s /bin/bash browser -c \
      "python3 /opt/bridge/record-workspace-package.py add $(printf %q "$PKG") $(printf %q "$DISPLAY_NAME") deb" \
      2>/dev/null || true
  fi
  chown -R browser:browser /home/browser/Desktop /home/browser/.local/share/applications /home/browser/.local/share/onebridge 2>/dev/null || true

  python3 -c 'import json,sys; print(json.dumps({"ok":True,"displayName":sys.argv[1],"kind":"deb","desktopIcon":sys.argv[2] or None,"package":sys.argv[3] or None}))' \
    "$DISPLAY_NAME" "$DESKTOP_ICON" "${PKG:-}"
}

install_appimage() {
  local NAME DEST
  NAME="${BASE%.*}"
  mkdir -p /home/browser/Applications /home/browser/Desktop /home/browser/.local/share/applications
  DEST="/home/browser/Applications/${BASE}"
  cp -f "$REAL" "$DEST"
  chmod +x "$DEST"
  cat > "/home/browser/.local/share/applications/${NAME}.desktop" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=${NAME}
Exec=${DEST} --no-sandbox
Icon=application-x-executable
Terminal=false
Categories=Utility;
X-OneBridge-Package=appimage:${NAME}
EOF
  cp -f "/home/browser/.local/share/applications/${NAME}.desktop" "/home/browser/Desktop/${NAME}.desktop"
  chmod +x "/home/browser/Desktop/${NAME}.desktop" "/home/browser/.local/share/applications/${NAME}.desktop"
  command -v gio >/dev/null 2>&1 && gio set "/home/browser/Desktop/${NAME}.desktop" metadata::trusted true 2>/dev/null || true
  if [[ -f /opt/bridge/record-workspace-package.py ]]; then
    su -s /bin/bash browser -c \
      "python3 /opt/bridge/record-workspace-package.py add $(printf %q "appimage:${NAME}") $(printf %q "$NAME") appimage" \
      2>/dev/null || true
  fi
  chown -R browser:browser /home/browser/Applications /home/browser/Desktop /home/browser/.local/share/applications /home/browser/.local/share/onebridge 2>/dev/null || true
  if pgrep -x xfdesktop >/dev/null 2>&1; then
    su -s /bin/bash browser -c "export DISPLAY=:1; xfdesktop --reload" 2>/dev/null || true
  fi
  python3 -c 'import json,sys; print(json.dumps({"ok":True,"displayName":sys.argv[1],"kind":"appimage","desktopIcon":sys.argv[1],"package":"appimage:"+sys.argv[1]}))' "$NAME"
}

case "$LOWER" in
  *.deb)
    install_deb
    exit 0
    ;;
  *.appimage)
    install_appimage
    exit 0
    ;;
esac

echo '{"ok":false,"error":"Unsupported package. Use a .deb or .AppImage (assistant zips need OneBridge host).","needsHost":true}'
exit 1
