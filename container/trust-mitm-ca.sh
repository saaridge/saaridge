#!/usr/bin/env bash
# Install OneBridge MITM CA into shared trust stores for every agent/app in the
# container (CONSTRAINTS: generic solutions only — no per-product trust paths).
#
# Covers: Debian system CAs, NSS (~/.pki/nssdb) for each /home/*, Chromium/Chrome
# managed CACertificates policy, optional Java cacerts, canonical PEM for env.
set -euo pipefail

CA_SRC="${1:-/opt/bridge/certs/onebridge-mitm-ca.crt}"
CA_NAME="OneBridge_MITM_CA"
CANONICAL="/opt/bridge/certs/onebridge-mitm-ca.crt"

if [[ ! -f "$CA_SRC" ]]; then
  echo "[trust-mitm-ca] missing CA at $CA_SRC" >&2
  exit 1
fi

mkdir -p /opt/bridge/certs
if [[ "$(readlink -f "$CA_SRC" 2>/dev/null || echo "$CA_SRC")" != "$(readlink -f "$CANONICAL" 2>/dev/null || echo "$CANONICAL")" ]]; then
  cp -f "$CA_SRC" "$CANONICAL"
fi
chmod 644 "$CANONICAL" 2>/dev/null || true
CA_SRC="$CANONICAL"

# Combined OpenSSL bundle: system roots + MITM CA. SSL_CERT_FILE / CURL_CA_BUNDLE
# *replace* the default store — pointing them at the MITM PEM alone breaks TUNNEL
# (public Amazon/Let's Encrypt certs fail verify). NODE_EXTRA_CA_CERTS stays additive.
CA_BUNDLE="/opt/bridge/certs/ca-bundle.crt"
SYSTEM_CA=""
for cand in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt; do
  if [[ -f "$cand" ]]; then
    SYSTEM_CA="$cand"
    break
  fi
done
if [[ -n "$SYSTEM_CA" ]]; then
  cat "$SYSTEM_CA" "$CA_SRC" >"$CA_BUNDLE"
else
  cp -f "$CA_SRC" "$CA_BUNDLE"
fi
chmod 644 "$CA_BUNDLE" 2>/dev/null || true
echo "[trust-mitm-ca] OpenSSL CA bundle at $CA_BUNDLE (system+mitm)"

# ── System trust (OpenSSL, curl, many CLI tools) ─────────────────────────
mkdir -p /usr/local/share/ca-certificates
cp -f "$CA_SRC" /usr/local/share/ca-certificates/onebridge-mitm-ca.crt
if command -v update-ca-certificates >/dev/null 2>&1; then
  update-ca-certificates >/tmp/update-ca-certificates.log 2>&1 || true
fi
# Rebuild bundle after update-ca-certificates so it includes the newly trusted CA
# once (system file already has it after update; keep MITM appended idempotently).
if [[ -f /etc/ssl/certs/ca-certificates.crt ]]; then
  if ! grep -q "OneBridge MITM CA" /etc/ssl/certs/ca-certificates.crt 2>/dev/null; then
    cat /etc/ssl/certs/ca-certificates.crt "$CA_SRC" >"$CA_BUNDLE"
  else
    cp -f /etc/ssl/certs/ca-certificates.crt "$CA_BUNDLE"
  fi
  chmod 644 "$CA_BUNDLE" 2>/dev/null || true
fi

# ── NSS DB (Firefox / some Chromium builds / tools using NSS) ────────────
install_nss() {
  local home="$1"
  local owner="${2:-}"
  local db="$home/.pki/nssdb"
  mkdir -p "$db"
  if ! command -v certutil >/dev/null 2>&1; then
    echo "[trust-mitm-ca] certutil not installed; skip NSS for $home"
    return 0
  fi
  if [[ ! -f "$db/cert9.db" ]]; then
    certutil -N -d "sql:$db" --empty-password >/dev/null 2>&1 || true
  fi
  certutil -D -d "sql:$db" -n "$CA_NAME" >/dev/null 2>&1 || true
  certutil -A -d "sql:$db" -t "C,," -n "$CA_NAME" -i "$CA_SRC"
  if [[ -n "$owner" ]]; then
    chown -R "$owner" "$home/.pki" 2>/dev/null || true
  fi
  echo "[trust-mitm-ca] NSS trusted in $db"
}

# Every agent home under /home, plus root if present
if [[ -d /home ]]; then
  for home in /home/*; do
    [[ -d "$home" ]] || continue
    user="$(basename "$home")"
    install_nss "$home" "$user:$user"
  done
fi
if [[ -d /root ]]; then
  install_nss /root root:root
fi

# ── Chromium / Chrome managed policy (Chromium-family only; CA only) ─────
# Electron apps that honor Chrome enterprise policy or --use-system-ca-store
# benefit; this is not a product-specific path.
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
print("[trust-mitm-ca] Chromium/Chrome CACertificates policy written")
PY
fi

# Default search engine → Google (Debian ships DuckDuckGo in master_preferences).
# Managed policy applies to all Chromium-family browsers in the container.
if command -v python3 >/dev/null 2>&1; then
  python3 <<'PY'
import json, os
search_policy = {
    "DefaultSearchProviderEnabled": True,
    "DefaultSearchProviderName": "Google",
    "DefaultSearchProviderKeyword": "google.com",
    "DefaultSearchProviderSearchURL": "https://www.google.com/search?q={searchTerms}",
    "DefaultSearchProviderSuggestURL": "https://www.google.com/complete/search?client=chrome&q={searchTerms}",
    "DefaultSearchProviderNewTabURL": "https://www.google.com/",
    "DefaultSearchProviderIconURL": "https://www.google.com/favicon.ico",
}
for path in (
    "/etc/chromium/policies/managed/onebridge-search.json",
    "/etc/opt/chrome/policies/managed/onebridge-search.json",
):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, "w").write(json.dumps(search_policy, indent=2) + "\n")
    except OSError:
        pass

# Seed new profiles with Google instead of DuckDuckGo.
for pref_path in (
    "/etc/chromium/master_preferences",
    "/etc/chromium/initial_preferences",
):
    if not os.path.isfile(pref_path):
        continue
    try:
        data = json.load(open(pref_path))
    except Exception:
        continue
    data["search_provider_overrides"] = [{
        "enabled": True,
        "encoding": "UTF-8",
        "favicon_url": "https://www.google.com/favicon.ico",
        "new_tab_url": "https://www.google.com/",
        "id": 1,
        "keyword": "google.com",
        "name": "Google",
        "search_url": "https://www.google.com/search?q={searchTerms}",
        "suggest_url": "https://www.google.com/complete/search?client=chrome&q={searchTerms}",
    }]
    data["search_provider_overrides_version"] = 1
    data["homepage"] = "https://www.google.com/"
    try:
        open(pref_path, "w").write(json.dumps(data, indent=2) + "\n")
        print(f"[trust-mitm-ca] patched {pref_path} → Google search")
    except OSError:
        pass
print("[trust-mitm-ca] Chromium/Chrome DefaultSearchProvider → Google")
PY
fi

# Shell identity: every shell gets host HOME + uname shims (no FUSE STAT).
# Full agent-env (proxy, pulse, Places links) is interactive-only.
if [[ -d /etc/profile.d ]]; then
  cat >/etc/profile.d/onebridge-identity.sh <<'EOF'
# OneBridge identity — safe for all shells (no HOME remap here).
# Remapping HOME in profile.d makes bash read $HOME/.profile from FUSE
# (/host/home) and can hang. HOME is set in sandbox ~/.profile instead.
export ONEBRIDGE_SANDBOX_HOME="${ONEBRIDGE_SANDBOX_HOME:-/home/browser}"
export ONEBRIDGE_HOST_HOME="${ONEBRIDGE_HOST_HOME:-/host/home}"
case ":${PATH}:" in
  *:/opt/bridge/host-bin:*) ;;
  *) export PATH="/opt/bridge/host-bin:${PATH}" ;;
esac
EOF
  chmod 644 /etc/profile.d/onebridge-identity.sh 2>/dev/null || true

  cat >/etc/profile.d/onebridge.sh <<'EOF'
# OneBridge: full agent-env for interactive shells only.
# Non-interactive shells never block docker health/repair with agent-env (FUSE hang).
case $- in
  *i*)
    if [[ -f /opt/bridge/agent-env.sh ]]; then
      # shellcheck source=/dev/null
      . /opt/bridge/agent-env.sh
    fi
    ;;
esac
EOF
  chmod 644 /etc/profile.d/onebridge.sh 2>/dev/null || true
  echo "[trust-mitm-ca] installed /etc/profile.d/onebridge-identity.sh + onebridge.sh"
fi

# Update existing browser profiles so omnibox search switches without a wipe.
if command -v python3 >/dev/null 2>&1; then
  python3 <<'PY'
import json, os, glob
google = [{
    "enabled": True,
    "encoding": "UTF-8",
    "favicon_url": "https://www.google.com/favicon.ico",
    "new_tab_url": "https://www.google.com/",
    "id": 1,
    "keyword": "google.com",
    "name": "Google",
    "search_url": "https://www.google.com/search?q={searchTerms}",
    "suggest_url": "https://www.google.com/complete/search?client=chrome&q={searchTerms}",
}]
homes = ["/home/browser"]
homes += glob.glob("/home/*")
seen = set()
for home in homes:
    if home in seen or not os.path.isdir(home):
        continue
    seen.add(home)
    for rel in (
        "chromium-bridge-profile/Default/Preferences",
        ".config/chromium/Default/Preferences",
        ".config/google-chrome/Default/Preferences",
    ):
        path = os.path.join(home, rel)
        if not os.path.isfile(path):
            continue
        try:
            data = json.load(open(path))
        except Exception:
            continue
        data["search_provider_overrides"] = google
        data["search_provider_overrides_version"] = 1
        # Drop mirrored DDG template so Chromium re-reads overrides/policy.
        dsp = data.get("default_search_provider_data")
        if isinstance(dsp, dict):
            dsp.pop("template_url_data", None)
            dsp.pop("mirrored_template_url_data", None)
        try:
            open(path, "w").write(json.dumps(data) + "\n")
            print(f"[trust-mitm-ca] profile search → Google: {path}")
        except OSError:
            pass
PY
fi

# ── Java truststore (optional; shared path for all JVM agents) ───────────
if command -v keytool >/dev/null 2>&1; then
  JAVA_TS="/opt/bridge/certs/jssecacerts"
  if [[ ! -f "$JAVA_TS" ]]; then
    # Seed from default cacerts when available
    for cand in \
      /etc/ssl/certs/java/cacerts \
      /usr/lib/jvm/default-java/lib/security/cacerts \
      /usr/lib/jvm/*/lib/security/cacerts; do
      # shellcheck disable=SC2086
      for f in $cand; do
        if [[ -f "$f" ]]; then
          cp -f "$f" "$JAVA_TS"
          break 2
        fi
      done
    done
  fi
  if [[ -f "$JAVA_TS" ]]; then
    keytool -delete -alias "$CA_NAME" -keystore "$JAVA_TS" -storepass changeit >/dev/null 2>&1 || true
    keytool -importcert -noprompt -alias "$CA_NAME" -file "$CA_SRC" \
      -keystore "$JAVA_TS" -storepass changeit >/dev/null 2>&1 || true
    chmod 644 "$JAVA_TS" 2>/dev/null || true
    echo "[trust-mitm-ca] Java truststore updated at $JAVA_TS"
  else
    echo "[trust-mitm-ca] no Java cacerts seed; skip JVM truststore"
  fi
fi

# ── Smoke: system trust path resolves our CA ─────────────────────────────
if command -v openssl >/dev/null 2>&1; then
  if openssl x509 -in "$CA_SRC" -noout >/dev/null 2>&1; then
    echo "[trust-mitm-ca] CA PEM ok at $CA_SRC"
  else
    echo "[trust-mitm-ca] WARNING: CA PEM failed openssl parse" >&2
  fi
fi

echo "[trust-mitm-ca] installed $CA_SRC (generic system/NSS/Chromium/Java hooks)"
