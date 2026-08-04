#!/usr/bin/env bash
# Verify container MITM proxy returns real HTTPS content.
set -euo pipefail
PROXY_PORT=$(python3 -c 'import json; print(json.load(open("/home/browser/.bridge-credentials"))["localProxyPort"])')
TOKEN=$(python3 -c 'import json; print(json.load(open("/home/browser/.bridge-credentials"))["token"])')
BODY=$(curl -fsS --max-time 12 \
  --proxy "http://127.0.0.1:${PROXY_PORT}" \
  --proxy-user "u:${TOKEN}" \
  --cacert /opt/bridge/certs/onebridge-mitm-ca.crt \
  "https://example.com/")
echo "$BODY" | grep -q "Example Domain"
echo PROXY_HTTPS_OK
