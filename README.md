# Agent Bridge Prototype

Host control plane + locked super-container + **host-side bridge** (MCP tools + HTTP passthrough proxy).

## Guarantees in this build

| Requirement | How it’s enforced |
|---|---|
| Agent cannot use another agent’s identity | Per-agent secret token; bridge ignores body `agentId` |
| Agent cannot steal sibling token | Dedicated Linux UID; credentials file `0600` in agent dir `0700` |
| Container net blocked except bridge | iptables allow only host `:7331` (MCP) and `:7332` (proxy) |
| Browse normally inside container via bridge | Chromium → per-agent local auth-proxy → host passthrough proxy |
| Bridge simple passthrough | Proxy tunnels CONNECT / relays HTTP with no filtering yet |

## Architecture

```text
Container agent UID
  ├─ MCP stdio proxy ──Bearer token──► host :7331 tools
  └─ Chromium → 127.0.0.1:18xxx auth-proxy ──Proxy-Auth token──► host :7332 ──► internet
```

## Run

```bash
npm start
# UI http://127.0.0.1:3847
# noVNC browsing http://127.0.0.1:6081/vnc.html?autoconnect=1

# Install sample agent
curl -s -X POST http://127.0.0.1:3847/api/agents/install \
  -H 'content-type: application/json' \
  -d "{\"hostPath\":\"$(pwd)/examples/sample-agent\"}"
```

On install the host:

1. Creates UID + token  
2. `docker cp` agent (container never pulls files)  
3. Writes private `.bridge-credentials`  
4. Starts `auth-proxy` + agent as that UID only  

## Notes

- Host Mac browser is unchanged (not forced through bridge).  
- In-container browsing is via noVNC + Chromium through the bridge proxy.  
- Path/URL/command allowlists are stubbed (`policy.allowAllProxy: true`); add filters later on the host bridge/proxy.  
