#!/usr/bin/env bash
# Publish HOST OS identity at /etc/os-release so agents/Cursor stop reporting Debian.
# Real Debian metadata is kept at /usr/lib/os-release.debian for recovery; apt Suites
# are pinned to bookworm in sources already.
set -euo pipefail

ID_FILE="${SAARIDGE_HOST_IDENTITY:-/opt/bridge/host-identity.json}"
OUT_LIB="${SAARIDGE_OS_RELEASE_OUT:-/usr/lib/os-release}"
BACKUP="${SAARIDGE_OS_RELEASE_DEBIAN:-/usr/lib/os-release.debian}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "[sync-host-os-release] need root" >&2
  exit 1
fi

# Preserve the real Debian file once (Install Assistant / emergency).
if [[ ! -f "$BACKUP" ]]; then
  if [[ -f /usr/lib/os-release ]]; then
    cp -a /usr/lib/os-release "$BACKUP"
  elif [[ -f /etc/os-release ]]; then
    cp -a /etc/os-release "$BACKUP"
  fi
fi

python3 - "$ID_FILE" "$OUT_LIB" <<'PY'
import json, os, sys

id_path, out_path = sys.argv[1], sys.argv[2]
d = {}
for p in (
    id_path,
    "/home/browser/.saaridge-host-identity.json",
    "/opt/bridge/host-identity.json",
):
    try:
        d = json.load(open(p))
        break
    except Exception:
        continue

plat = d.get("platform") or "darwin"
ostype = d.get("osType") or ("Darwin" if plat == "darwin" else "Linux")
release = str(d.get("release") or "")
pretty = d.get("prettyName") or ostype
host = d.get("hostname") or "host"
arch = d.get("arch") or "arm64"

# Darwin major → macOS marketing version id
major = release.split(".")[0] if release else ""
macos_ver = {"24": "15", "23": "14", "22": "13", "21": "12"}.get(major, major or "15")
codename = {
    "15": "sequoia",
    "14": "sonoma",
    "13": "ventura",
    "12": "monterey",
}.get(macos_ver, "macos")

if plat == "darwin":
    body = f"""PRETTY_NAME="{pretty}"
NAME="macOS"
VERSION_ID="{macos_ver}"
VERSION="{macos_ver} ({codename})"
VERSION_CODENAME={codename}
ID=macos
ID_LIKE=darwin
HOME_URL="https://www.apple.com/macos/"
SUPPORT_URL="https://support.apple.com/"
SAARIDGE_HOST="{host}"
SAARIDGE_ARCH="{arch}"
SAARIDGE_KERNEL_RELEASE="{release}"
SAARIDGE_NOTE="Host OS identity for agents"

"""
elif plat == "win32":
    body = f"""PRETTY_NAME="{pretty}"
NAME="Windows"
ID=windows
VERSION_ID="{release}"
SAARIDGE_HOST="{host}"
SAARIDGE_NOTE="Host OS identity for agents"

"""
else:
    body = f"""PRETTY_NAME="{pretty}"
NAME="{ostype}"
ID=linux
VERSION_ID="{release}"
SAARIDGE_HOST="{host}"
SAARIDGE_NOTE="Host OS identity for agents."
"""

os.makedirs(os.path.dirname(out_path), exist_ok=True)
# Replace symlink target file contents (Debian: /etc/os-release → ../usr/lib/os-release)
with open(out_path, "w", encoding="utf-8") as f:
    f.write(body)
print(f"[sync-host-os-release] wrote {out_path} → {pretty}")
PY

# Keep apt on bookworm even when os-release says macos.
mkdir -p /etc/apt/apt.conf.d
cat >/etc/apt/apt.conf.d/99saaridge-bookworm <<'EOF'
APT::Default-Release "bookworm";
EOF

# Ensure /etc/os-release points at the lib file (Debian default).
ln -sfn ../usr/lib/os-release /etc/os-release
