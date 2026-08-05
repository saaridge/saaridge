#!/usr/bin/env bash
# Source this in every agent / desktop session.
# Forces HTTP(S) through the local auth-proxy (→ host bridge) and prefers
# host-side tools via MCP. Agents should feel like they run on the host.
#
# Usage: source /opt/bridge/agent-env.sh

_CRED="${BRIDGE_CREDENTIALS_FILE:-}"
if [[ -z "$_CRED" || ! -f "$_CRED" ]]; then
  # Prefer sandbox credentials even when HOME is remapped to /host/home.
  for _try in \
    "${BRIDGE_CREDENTIALS_FILE:-}" \
    /home/browser/.bridge-credentials \
    "${SAARIDGE_SANDBOX_HOME:-}/.bridge-credentials" \
    "${HOME:-}/.bridge-credentials"
  do
    if [[ -n "${_try}" && -f "${_try}" ]]; then
      _CRED="$_try"
      export BRIDGE_CREDENTIALS_FILE="$_CRED"
      break
    fi
  done
fi

if [[ -n "$_CRED" && -f "$_CRED" ]]; then
  _PORT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["localProxyPort"])' "$_CRED" 2>/dev/null || true)"
  if [[ -n "${_PORT:-}" ]]; then
    export LOCAL_PROXY_PORT="$_PORT"
    export http_proxy="http://127.0.0.1:${_PORT}"
    export https_proxy="http://127.0.0.1:${_PORT}"
    export HTTP_PROXY="http://127.0.0.1:${_PORT}"
    export HTTPS_PROXY="http://127.0.0.1:${_PORT}"
    export ALL_PROXY="http://127.0.0.1:${_PORT}"
    export all_proxy="http://127.0.0.1:${_PORT}"
  fi
fi

export NO_PROXY="127.0.0.1,localhost,host.docker.internal"
export no_proxy="$NO_PROXY"
export BRIDGE_URL="${BRIDGE_URL:-http://host.docker.internal:7331}"
export BRIDGE_PROXY_HOST="${BRIDGE_PROXY_HOST:-host.docker.internal}"
export BRIDGE_PROXY_PORT="${BRIDGE_PROXY_PORT:-7332}"

export SAARIDGE_HOST_HOME="${SAARIDGE_HOST_HOME:-/host/home}"
export SAARIDGE_SANDBOX_HOME="${SAARIDGE_SANDBOX_HOME:-/home/browser}"
# Agent-facing HOME is always the mediated host home. Apps that need the
# Linux sandbox (Chromium profile, Cursor user-data, XFCE) must set
# HOME="$SAARIDGE_SANDBOX_HOME" themselves (launch-browser / start-desktop).
# Do not gate on `test -d` — that STAT hangs when FUSE is wedged and leaves
# agents on /home/browser.
export HOME="$SAARIDGE_HOST_HOME"
# Host-bin shims first: curl/wget/uname + mediated host shell
export PATH="/opt/bridge/host-bin:${PATH}"
# Default shell for agent terminals: commands run on the host via the bridge.
if [[ -x /opt/bridge/host-bin/host-shell ]]; then
  export SHELL=/opt/bridge/host-bin/host-shell
  export SAARIDGE_HOST_SHELL=1
fi

# Node 22+: honor HTTP(S)_PROXY for fetch (agents that call network in-process)
case " ${NODE_OPTIONS:-} " in
  *" --use-env-proxy "*) ;;
  *) export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--use-env-proxy" ;;
esac

# Pulse (desktop browser audio)
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-browser}"
export PULSE_RUNTIME_PATH="${PULSE_RUNTIME_PATH:-$XDG_RUNTIME_DIR/pulse}"
if [[ -S "${PULSE_RUNTIME_PATH}/native" ]]; then
  export PULSE_SERVER="unix:${PULSE_RUNTIME_PATH}/native"
fi

# Hint for agents: filesystem + privileged network live on the HOST via MCP/FUSE
export SAARIDGE_HOST_VIA="mcp+proxy+fuse"
export BROWSER="${BROWSER:-/opt/bridge/bridge-browser.sh}"

# Mediated host project tree (FUSE → Data API → ~/Saaridge on the host)
export SAARIDGE_HOST_MOUNT="${SAARIDGE_HOST_MOUNT:-/host}"
export SAARIDGE_SHARED="${SAARIDGE_SHARED:-/host/shared}"
# Host home browse tree (FUSE → Data API → os.homedir(), read-only)
export SAARIDGE_HOST_HOME="${SAARIDGE_HOST_HOME:-/host/home}"
if [[ -n "$_CRED" && -f "$_CRED" ]]; then
  _AGENT_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("agentId",""))' "$_CRED" 2>/dev/null || true)"
  _WS_HINT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("hostWorkspace",""))' "$_CRED" 2>/dev/null || true)"
  _HOME_HINT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("hostHome",""))' "$_CRED" 2>/dev/null || true)"
  _HOST_NAME="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("hostHostname",""))' "$_CRED" 2>/dev/null || true)"
  if [[ -n "${_WS_HINT:-}" ]]; then
    export SAARIDGE_PROJECTS="$_WS_HINT"
  elif [[ -n "${_AGENT_ID:-}" ]]; then
    export SAARIDGE_PROJECTS="/host/workspaces/${_AGENT_ID}"
  fi
  if [[ -n "${_HOME_HINT:-}" ]]; then
    export SAARIDGE_HOST_HOME="$_HOME_HINT"
  fi
  if [[ -n "${_HOST_NAME:-}" ]]; then
    export SAARIDGE_HOST_NAME="$_HOST_NAME"
  fi
fi
export SAARIDGE_PROJECTS="${SAARIDGE_PROJECTS:-/host/workspaces/workspace-desktop}"
export SAARIDGE_HOST_HOME="${SAARIDGE_HOST_HOME:-/host/home}"
export SAARIDGE_HOST_NAME="${SAARIDGE_HOST_NAME:-Host}"
# Docker Desktop sometimes reports Unknown_<mac> — useless Places/Desktop label.
if [[ "${SAARIDGE_HOST_NAME}" == Unknown_* ]]; then
  export SAARIDGE_HOST_NAME=Host
fi
# Cursor / editors: open projects under this path (not container-local copies)
export CURSOR_PROJECT_DIR="${CURSOR_PROJECT_DIR:-$SAARIDGE_PROJECTS}"
export SAARIDGE_HOST_EXEC_CWD="${SAARIDGE_HOST_EXEC_CWD:-$SAARIDGE_PROJECTS}"

# Host OS identity (authoritative for agents — not sandbox Linux).
export SAARIDGE_HOST_IDENTITY="${SAARIDGE_HOST_IDENTITY:-/opt/bridge/host-identity.json}"
if [[ -n "$_CRED" && -f "$_CRED" ]]; then
  eval "$(python3 - "$_CRED" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
def exp(k, v):
    if v is None or v == "":
        return
    v = str(v).replace("'", "'\"'\"'")
    print(f"export {k}='{v}'")
exp("SAARIDGE_HOST_PLATFORM", c.get("hostPlatform"))
exp("SAARIDGE_HOST_ARCH", c.get("hostArch"))
exp("SAARIDGE_HOST_RELEASE", c.get("hostRelease"))
exp("SAARIDGE_HOST_OSTYPE", c.get("hostOsType"))
exp("SAARIDGE_HOST_NATIVE_HOME", c.get("hostNativeHome"))
exp("SAARIDGE_HOST_USERNAME", c.get("hostUsername"))
PY
)" 2>/dev/null || true
fi
# Match host uname(1) family for naive probes (Darwin/Linux/…).
if [[ -n "${SAARIDGE_HOST_OSTYPE:-}" ]]; then
  export OSTYPE="${SAARIDGE_HOST_OSTYPE}"
fi
if [[ -n "${SAARIDGE_HOST_USERNAME:-}" ]]; then
  export USER="${SAARIDGE_HOST_USERNAME}"
  export LOGNAME="${SAARIDGE_HOST_USERNAME}"
fi

# Shell orientation for agents (host-only).
export SAARIDGE_SHELL_NOTE="OS=${SAARIDGE_HOST_OSTYPE:-host}. Home=${SAARIDGE_HOST_HOME}. Workspace=${SAARIDGE_PROJECTS}."
# Write layout for agents; do NOT clobber a full host-identity.json from the bridge.
python3 - <<PY 2>/dev/null || true
import json, os
layout = {
  "virtualizedOnHost": True,
  "platform": os.environ.get("SAARIDGE_HOST_PLATFORM"),
  "osType": os.environ.get("SAARIDGE_HOST_OSTYPE"),
  "arch": os.environ.get("SAARIDGE_HOST_ARCH"),
  "release": os.environ.get("SAARIDGE_HOST_RELEASE"),
  "hostname": os.environ.get("SAARIDGE_HOST_NAME"),
  "mount": os.environ.get("SAARIDGE_HOST_MOUNT", "/host"),
  "workspace": os.environ.get("SAARIDGE_PROJECTS"),
  "shared": os.environ.get("SAARIDGE_SHARED", "/host/shared"),
  "home": os.environ.get("SAARIDGE_HOST_HOME", "/host/home"),
  "terminal_exec": "disabled",
  "note": os.environ.get("SAARIDGE_SHELL_NOTE"),
}
for d in ("/opt/bridge",):
    try:
        open(os.path.join(d, "host-layout.json"), "w").write(json.dumps(layout, indent=2) + "\n")
    except OSError:
        pass
# Do not drop host-layout.json in $HOME — keeps the sandbox home uncluttered.
try:
    home = os.environ.get("HOME") or ""
    if home:
        p = os.path.join(home, "host-layout.json")
        if os.path.isfile(p):
            os.remove(p)
except OSError:
    pass

# Merge credentials into identity only when we have real host platform fields.
cred = os.environ.get("BRIDGE_CREDENTIALS_FILE") or os.path.expanduser("~/.bridge-credentials")
identity_path = "/opt/bridge/host-identity.json"
home_id = os.path.join(os.environ.get("HOME") or "/tmp", ".saaridge-host-identity.json")
try:
    c = json.load(open(cred)) if os.path.isfile(cred) else {}
except Exception:
    c = {}
plat = c.get("hostPlatform") or os.environ.get("SAARIDGE_HOST_PLATFORM")
if plat:
    arch = c.get("hostArch") or os.environ.get("SAARIDGE_HOST_ARCH") or "arm64"
    machine = "arm64" if arch == "arm64" else ("x86_64" if arch == "x64" else arch)
    sysname = c.get("hostOsType") or os.environ.get("SAARIDGE_HOST_OSTYPE") or (
        "Darwin" if plat == "darwin" else ("Windows_NT" if plat == "win32" else "Linux")
    )
    host = c.get("hostHostname") or os.environ.get("SAARIDGE_HOST_NAME") or "host"
    release = c.get("hostRelease") or os.environ.get("SAARIDGE_HOST_RELEASE") or ""
    identity = {
        "virtualizedOnHost": True,
        "hostname": host,
        "platform": plat,
        "osType": sysname,
        "arch": arch,
        "release": release,
        "homedir": c.get("hostNativeHome"),
        "shell": {
            "mount": layout["mount"],
            "workspace": layout["workspace"],
            "shared": layout["shared"],
            "home": layout["home"],
            "cwdHint": layout["workspace"],
        },
        "uname": {
            "s": sysname,
            "n": host,
            "r": release,
            "m": machine,
            "a": f"{sysname} {host} {release} {machine}".strip(),
        },
        "note": layout["note"],
    }
    for path in (identity_path, home_id):
        try:
            open(path, "w").write(json.dumps(identity, indent=2) + "\n")
        except OSError:
            pass
PY

# FS binary IPC is host-loopback only; FUSE uses HTTP Data API from the container.
export HOSTFS_IPC="${HOSTFS_IPC:-0}"

# Force all HTTP(S) clients (Node fetch, Python requests if configured, MCP servers)
# through the local auth-proxy → host MITM. Fail-closed iptables blocks non-proxy egress.
# Shared MITM CA for every process in the container (CONSTRAINTS: generic only).
_OB_CA="${SAARIDGE_MITM_CA:-/opt/bridge/certs/saaridge-mitm-ca.crt}"
# OpenSSL-style env vars *replace* the default trust store — use system+MITM
# bundle so adaptive TUNNEL (real public certs) still verifies.
_OB_BUNDLE="${SAARIDGE_CA_BUNDLE:-/opt/bridge/certs/ca-bundle.crt}"
if [[ ! -f "$_OB_BUNDLE" ]]; then
  _OB_BUNDLE="$_OB_CA"
fi
export REQUESTS_CA_BUNDLE="${REQUESTS_CA_BUNDLE:-$_OB_BUNDLE}"
export SSL_CERT_FILE="${SSL_CERT_FILE:-$_OB_BUNDLE}"
export CURL_CA_BUNDLE="${CURL_CA_BUNDLE:-$_OB_BUNDLE}"
# Node adds this file to its built-in Mozilla store (MITM-only PEM is correct).
export NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-$_OB_CA}"
# JVM agents that honor a custom truststore path (seeded by trust-mitm-ca.sh).
if [[ -f /opt/bridge/certs/jssecacerts ]]; then
  case "${JAVA_TOOL_OPTIONS:-}" in
    *javax.net.ssl.trustStore=/opt/bridge/certs/jssecacerts*) ;;
    *)
      export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:+$JAVA_TOOL_OPTIONS }-Djavax.net.ssl.trustStore=/opt/bridge/certs/jssecacerts -Djavax.net.ssl.trustStorePassword=changeit"
      ;;
  esac
fi
unset _OB_CA _OB_BUNDLE

# Host-home Places link lives in the *sandbox* home (XFCE), never under /host/home.
_HOME_DIR="${SAARIDGE_SANDBOX_HOME:-/home/browser}"
# Bound FUSE probes — skip quietly if hostfs is wedged.
if timeout 1 test -d "$SAARIDGE_HOST_HOME" 2>/dev/null; then
  rm -f "${_HOME_DIR}/Projects" "${_HOME_DIR}/Host Home" "${_HOME_DIR}/host-home" \
    "${_HOME_DIR}/Desktop/Host Projects" "${_HOME_DIR}/Desktop/Host-Projects" \
    "${_HOME_DIR}/host-layout.json" 2>/dev/null || true
  rm -f "${_HOME_DIR}"/Unknown_*\ Home "${_HOME_DIR}/Desktop"/Unknown_*\ Home 2>/dev/null || true
  for _d in Documents Music Pictures Public Templates Videos; do
    if [[ -d "${_HOME_DIR}/${_d}" ]] && [[ -z "$(find "${_HOME_DIR}/${_d}" -mindepth 1 -maxdepth 1 2>/dev/null | head -1)" ]]; then
      rmdir "${_HOME_DIR}/${_d}" 2>/dev/null || true
    fi
  done
  ln -sfn "$SAARIDGE_HOST_HOME" "${_HOME_DIR}/${SAARIDGE_HOST_NAME} Home" 2>/dev/null || true
  if [[ -d "${SAARIDGE_HOST_HOME}/Downloads" ]]; then
    if [[ -L "${_HOME_DIR}/Downloads" ]] || [[ ! -e "${_HOME_DIR}/Downloads" ]]; then
      ln -sfn "${SAARIDGE_HOST_HOME}/Downloads" "${_HOME_DIR}/Downloads" 2>/dev/null || true
    elif [[ -d "${_HOME_DIR}/Downloads" ]] && [[ -z "$(find "${_HOME_DIR}/Downloads" -mindepth 1 -maxdepth 1 2>/dev/null | head -1)" ]]; then
      rmdir "${_HOME_DIR}/Downloads" 2>/dev/null || true
      ln -sfn "${SAARIDGE_HOST_HOME}/Downloads" "${_HOME_DIR}/Downloads" 2>/dev/null || true
    fi
  fi
fi
