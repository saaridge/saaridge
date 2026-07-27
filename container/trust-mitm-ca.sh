#!/usr/bin/env bash
# Install OneBridge MITM CA into system + Chromium/NSS trust stores.
# After this, HTTPS through the inspecting proxy shows as secure (padlock).
set -euo pipefail

CA_SRC="${1:-/opt/bridge/certs/onebridge-mitm-ca.crt}"
CA_NAME="OneBridge_MITM_CA"

if [[ ! -f "$CA_SRC" ]]; then
  echo "[trust-mitm-ca] missing CA at $CA_SRC" >&2
  exit 1
fi

# System trust (used by curl and many apps; Chromium on Debian often uses this too)
mkdir -p /usr/local/share/ca-certificates
cp -f "$CA_SRC" /usr/local/share/ca-certificates/onebridge-mitm-ca.crt
if command -v update-ca-certificates >/dev/null 2>&1; then
  update-ca-certificates >/tmp/update-ca-certificates.log 2>&1 || true
fi

# NSS DB for Chromium / browser user
install_nss() {
  local home="$1"
  local db="$home/.pki/nssdb"
  mkdir -p "$db"
  if ! command -v certutil >/dev/null 2>&1; then
    echo "[trust-mitm-ca] certutil not installed; system CA only"
    return 0
  fi
  # Create DB if needed
  if [[ ! -f "$db/cert9.db" ]]; then
    certutil -N -d "sql:$db" --empty-password >/dev/null 2>&1 || true
  fi
  # Remove old nick if present, then add as trusted CA
  certutil -D -d "sql:$db" -n "$CA_NAME" >/dev/null 2>&1 || true
  certutil -A -d "sql:$db" -t "C,," -n "$CA_NAME" -i "$CA_SRC"
  chown -R browser:browser "$home/.pki" 2>/dev/null || true
  echo "[trust-mitm-ca] NSS trusted in $db"
}

install_nss /home/browser

# Chrome Root Store ignores system CAs unless policy adds them (or --use-system-ca-store).
# Enterprise policy is the reliable path for Debian Chromium.
mkdir -p /etc/chromium/policies/managed /etc/opt/chrome/policies/managed
if command -v openssl >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
  DER_B64="$(openssl x509 -in "$CA_SRC" -outform DER | base64 -w0 2>/dev/null || openssl x509 -in "$CA_SRC" -outform DER | base64)"
  python3 - "$DER_B64" <<'PY'
import json, sys
b64 = sys.argv[1].strip()
policy = {
    "CACertificates": [b64],
    "CACertificateManagementAllowed": 1,
}
for path in (
    "/etc/chromium/policies/managed/onebridge-mitm.json",
    "/etc/opt/chrome/policies/managed/onebridge-mitm.json",
):
    try:
        open(path, "w").write(json.dumps(policy, indent=2) + "\n")
    except OSError:
        pass
print("[trust-mitm-ca] Chromium CACertificates policy written")
PY
fi

echo "[trust-mitm-ca] installed $CA_SRC"
