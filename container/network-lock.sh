#!/usr/bin/env bash
# Allow only host bridge MCP/Data API (:7331), inspecting proxy (:7332),
# and control plane (:3847). FAIL CLOSED — no soft-open egress.
set -euo pipefail

BRIDGE_HOST="${BRIDGE_HOST:-host.docker.internal}"
BRIDGE_PORT="${BRIDGE_PORT:-7331}"
BRIDGE_PROXY_PORT="${BRIDGE_PROXY_PORT:-7332}"
CONTROL_PORT="${CONTROL_PORT:-3847}"

if ! command -v iptables >/dev/null 2>&1; then
  echo "[network-lock] FATAL: iptables not available — refusing open egress" >&2
  exit 1
fi

BRIDGE_IP="$(getent hosts "$BRIDGE_HOST" | awk '{print $1}' | head -n1 || true)"
if [[ -z "${BRIDGE_IP}" ]]; then
  echo "[network-lock] FATAL: could not resolve $BRIDGE_HOST — refusing open egress" >&2
  exit 1
fi

iptables -F OUTPUT || true
iptables -A OUTPUT -o lo -j ACCEPT
# DNS so host.docker.internal / names used by the host proxy path keep working
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
iptables -A OUTPUT -d "$BRIDGE_IP" -p tcp --dport "$BRIDGE_PORT" -j ACCEPT
iptables -A OUTPUT -d "$BRIDGE_IP" -p tcp --dport "$BRIDGE_PROXY_PORT" -j ACCEPT
iptables -A OUTPUT -d "$BRIDGE_IP" -p tcp --dport "$CONTROL_PORT" -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -j DROP

# Harden: prevent same-UID ptrace of siblings where possible (best-effort)
if [[ -w /proc/sys/kernel/yama/ptrace_scope ]]; then
  echo 1 > /proc/sys/kernel/yama/ptrace_scope || true
fi

echo "[network-lock] egress locked to ${BRIDGE_IP}:{${BRIDGE_PORT},${BRIDGE_PROXY_PORT},${CONTROL_PORT}}"
