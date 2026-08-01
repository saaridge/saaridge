# Agent Bridge Prototype

Host control plane + locked super-container + **host-side bridge** (MCP tools + Data API + HTTP MITM proxy).

## Guarantees in this build

| Requirement | How it’s enforced |
|---|---|
| Agent cannot use another agent’s identity | Per-agent secret token; bridge ignores body `agentId` |
| Agent cannot steal sibling token | Dedicated Linux UID; credentials file `0600` in agent dir `0700` |
| Container net blocked except bridge | iptables allow only host `:7331` (MCP/Data API) and `:7332` (proxy) |
| Host project files only via bridge | No bind-mount of project dirs; `/host` is FUSE → Data API → `~/OneBridge/` |
| Browse normally inside container via bridge | Chromium → per-agent local auth-proxy → host MITM proxy |
| Visibility / transform | Async audit JSONL; optional read redact / write block globs; net body hooks |

## Architecture

```text
Container
  ├─ /host (FUSE) ──HTTPS chunked──► host :7331 /v1/fs/*
  ├─ MCP stdio proxy ──Bearer──► host :7331 tools (same data core)
  └─ Chromium → 127.0.0.1:18xxx auth-proxy ──► host :7332 ──► internet
Host
  ~/OneBridge/workspaces/<agentId>/   (read-write)
  ~/OneBridge/shared/                 (read-only by default)
```

## Cursor / project location

Open projects under **`/host/workspaces/<agentId>/`** inside the workspace desktop (also linked as `~/Projects` and Desktop “Host Projects”). That tree is the host’s `~/OneBridge/workspaces/<agentId>/`, mediated by the bridge (policy, audit, transforms). Do not store durable project data only under container-local paths.

## Docker / FUSE requirements

- Compose passes `/dev/fuse` and `SYS_ADMIN` (plus `apparmor:unconfined` where needed).
- On Docker Desktop, ensure the VM exposes fuse; rebuild the image after pulling these changes.

## Run

**Primary UI:** Electron app — one **Settings** window (Policies | API key) plus the workspace desktop.

```bash
npm install
npm run app:install   # once
npm run app           # starts host if needed, opens OneBridge window
```

Title bar **Settings** → side panel: **Policies** (global + per-agent overrides) or **API key**.

Host APIs (dev / automation) still listen on localhost only:

```bash
npm start
# Control plane http://127.0.0.1:3847  (dev fallback; prefer npm run app)

# Install sample agent
curl -s -X POST http://127.0.0.1:3847/api/agents/install \
  -H 'content-type: application/json' \
  -d "{\"hostPath\":\"$(pwd)/examples/sample-agent\"}"
```

AI policy config is host-private (`state/private/ai-policies.json`). Effective policy = global ∪ agent enables, with per-agent overrides winning when set.
## Data API (port 7331)

Auth: `Authorization: Bearer <agent-token>`. Header `X-OneBridge-FS: 1`.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/v1/fs/health` | data plane ready |
| GET | `/v1/fs/stat?path=` | stat |
| GET | `/v1/fs/list?path=` | list |
| GET | `/v1/fs/read?path=&offset=&length=` | chunked read |
| PUT | `/v1/fs/write?path=&offset=` | chunked write |
| POST | `/v1/fs/mkdir` | mkdir |
| DELETE | `/v1/fs/path?path=` | unlink/rmdir |
| POST | `/v1/fs/rename` | rename |
| GET | `/v1/audit` | recent file + net audit |

## Notes

- Host Mac browser is unchanged (not forced through bridge).
- Paths outside `~/OneBridge/` are denied by default.
- `terminal_exec` cwd is restricted to allowlisted OneBridge roots.
