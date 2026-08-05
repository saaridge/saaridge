#!/usr/bin/env bash
# Fetch host-run gzip fixture via container MITM proxy. Args: HOST_PORT MARKER
set -euo pipefail
HOST_PORT="${1:?host fixture port}"
MARK="${2:?marker}"

PROXY_PORT=$(python3 -c 'import json; print(json.load(open("/home/browser/.bridge-credentials"))["localProxyPort"])')
TOKEN=$(python3 -c 'import json; print(json.load(open("/home/browser/.bridge-credentials"))["token"])')
TMP=/opt/bridge/proxy-gzip-test.bin

curl -fsS --max-time 15 \
  --proxy "http://127.0.0.1:${PROXY_PORT}" \
  --proxy-user "u:${TOKEN}" \
  --cacert /opt/bridge/certs/saaridge-mitm-ca.crt \
  "https://localhost:${HOST_PORT}/" \
  --resolve "localhost:${HOST_PORT}:127.0.0.1" > "${TMP}"

python3 - "${MARK}" <<'PY'
import sys, zlib
mark = sys.argv[1]
raw = open("/opt/bridge/proxy-gzip-test.bin", "rb").read()
text = zlib.decompress(raw).decode("utf-8", "replace")
if mark not in text:
    raise SystemExit(f"marker missing in {len(text)} byte body")
print("PROXY_GZIP_OK")
PY
