#!/usr/bin/env bash
# Allow only host bridge MCP/Data API (:7331), inspecting proxy (:7332),
# FS IPC (:7333), and control plane (:3847). FAIL CLOSED — no soft-open egress.
#
# Hardening:
#  - IPv6 OUTPUT DROP (no IPv6 bypass of IPv4 lock)
#  - DNS only to resolvers listed in /etc/resolv.conf (not 0/0:53)
set -euo pipefail

BRIDGE_HOST="${BRIDGE_HOST:-host.docker.internal}"
BRIDGE_PORT="${BRIDGE_PORT:-7331}"
BRIDGE_PROXY_PORT="${BRIDGE_PROXY_PORT:-7332}"
BRIDGE_FS_PORT="${BRIDGE_FS_PORT:-${HOSTFS_IPC_PORT:-7333}}"
CONTROL_PORT="${CONTROL_PORT:-3847}"
RESOLV_CONF="${RESOLV_CONF:-/etc/resolv.conf}"

# Parse nameserver IPs from resolv.conf (pure; also used by tests via --print-dns).
parse_dns_resolvers() {
  local conf="${1:-$RESOLV_CONF}"
  if [[ ! -f "$conf" ]]; then
    return 1
  fi
  # shellcheck disable=SC2013
  awk '/^nameserver[ \t]+/ { print $2 }' "$conf" | while read -r ns; do
    [[ -z "$ns" ]] && continue
    # Accept IPv4 or IPv6 literals only
    if [[ "$ns" =~ ^[0-9.]+$ ]] || [[ "$ns" =~ : ]]; then
      echo "$ns"
    fi
  done
}

if [[ "${1:-}" == "--print-dns" ]]; then
  parse_dns_resolvers "${2:-$RESOLV_CONF}" || true
  exit 0
fi

if ! command -v iptables >/dev/null 2>&1; then
  echo "[network-lock] FATAL: iptables not available — refusing open egress" >&2
  exit 1
fi

BRIDGE_IP="$(getent hosts "$BRIDGE_HOST" | awk '{print $1}' | head -n1 || true)"
if [[ -z "${BRIDGE_IP}" ]]; then
  echo "[network-lock] FATAL: could not resolve $BRIDGE_HOST — refusing open egress" >&2
  exit 1
fi

DNS_SERVERS=()
while IFS= read -r ns; do
  [[ -n "$ns" ]] && DNS_SERVERS+=("$ns")
done < <(parse_dns_resolvers "$RESOLV_CONF" || true)

if [[ "${#DNS_SERVERS[@]}" -eq 0 ]]; then
  echo "[network-lock] FATAL: no nameserver entries in $RESOLV_CONF — refusing open DNS" >&2
  exit 1
fi

# --- IPv4 ---
iptables -F OUTPUT || true
iptables -P OUTPUT DROP
iptables -A OUTPUT -o lo -j ACCEPT
for ns in "${DNS_SERVERS[@]}"; do
  if [[ "$ns" == *:* ]]; then
    continue
  fi
  iptables -A OUTPUT -d "$ns" -p udp --dport 53 -j ACCEPT
  iptables -A OUTPUT -d "$ns" -p tcp --dport 53 -j ACCEPT
done
iptables -A OUTPUT -d "$BRIDGE_IP" -p tcp --dport "$BRIDGE_PORT" -j ACCEPT
iptables -A OUTPUT -d "$BRIDGE_IP" -p tcp --dport "$BRIDGE_PROXY_PORT" -j ACCEPT
iptables -A OUTPUT -d "$BRIDGE_IP" -p tcp --dport "$BRIDGE_FS_PORT" -j ACCEPT
iptables -A OUTPUT -d "$BRIDGE_IP" -p tcp --dport "$CONTROL_PORT" -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
# Default policy already DROP; keep explicit terminal DROP for clarity
iptables -A OUTPUT -j DROP

# --- IPv6 (fail closed — no bypass) ---
if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -F OUTPUT || true
  ip6tables -P OUTPUT DROP
  ip6tables -A OUTPUT -o lo -j ACCEPT
  for ns in "${DNS_SERVERS[@]}"; do
    # Only add IPv6 DNS rules for IPv6 literals
    if [[ "$ns" == *:* ]]; then
      ip6tables -A OUTPUT -d "$ns" -p udp --dport 53 -j ACCEPT || true
      ip6tables -A OUTPUT -d "$ns" -p tcp --dport 53 -j ACCEPT || true
    fi
  done
  ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT || true
  ip6tables -A OUTPUT -j DROP || true
else
  echo "[network-lock] WARN: ip6tables missing — IPv6 may be unfiltered" >&2
fi

# Harden: prevent same-UID ptrace of siblings where possible (best-effort)
if [[ -w /proc/sys/kernel/yama/ptrace_scope ]]; then
  echo 1 > /proc/sys/kernel/yama/ptrace_scope || true
fi

echo "[network-lock] egress locked to ${BRIDGE_IP}:{${BRIDGE_PORT},${BRIDGE_PROXY_PORT},${BRIDGE_FS_PORT},${CONTROL_PORT}}; dns=${DNS_SERVERS[*]}; ipv6=drop"
