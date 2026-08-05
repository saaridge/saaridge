# Saaridge

**Alpha `0.0.1`** — a trust layer for AI agents on your computer (Apache 2.0).

## Why Saaridge

AI agents are useful, but they should not get a free pass to everything on your machine or everything they send over the internet. Saaridge sits **between you and the agent** so **you** decide what kinds of data the agent may see, and what it may send out.

**In plain terms:**

1. **You set the rules** — policies for secrets, personal data, payment info, and more (redact, block, or allow).
2. **The agent works on mediated data** — when it reads files or browses, sensitive values can be replaced with safe placeholders (and secrets become `vault://…` markers instead of the real values).
3. **When the agent writes or sends data, we put the real values back** where policy allows — so tools and websites still get what they need, without leaving permanent secret copies inside the agent’s world.
4. **Compute and data stay separated** — the agent runs in a locked workspace; your real files and network stay on the host and only move through Saaridge’s bridge.

You keep control. The agent keeps the ability to work.

## How it stays secure

Saaridge is built so the agent’s workspace is **not** your Mac (or PC) with the doors open. It is a **secure compute space** next to your data.

| What we separate | What that means for you                                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Compute**      | Agents run inside an isolated container desktop. They cannot freely roam your whole computer.                                                                                          |
| **Data**         | Your projects live under `~/Saaridge/` on the host. The agent sees them only through a mediated bridge — not as a raw folder mount.                                                    |
| **Network**      | Outbound internet from the workspace is locked down. Traffic goes through Saaridge’s proxy so policies can apply. If the bridge is down, the workspace does **not** get open internet. |
| **Secrets**      | Real secret values are stored encrypted on the host. Agents see markers and metadata — not the vault key or ciphertext.                                                                |

**Measures we take:**

- **Policy on every host file path** the agent uses (read / write / list) — your visibility rules apply before content reaches the agent, and again when writing back.
- **Per-agent identity** — each assistant has its own token and private workspace; one agent cannot pretend to be another or steal a sibling’s credentials.
- **No host shell for agents** — they cannot “just run a command on your Mac” to bypass the bridge.
- **Fail-closed network lock** — only approved paths to the host bridge/proxy; IPv4, IPv6, and DNS are constrained so the container cannot quietly phone home some other way.
- **HTTPS inspection on the mediated path** — so redacted or vault-marked text can be handled on the way out and back in (with careful exceptions only when a site cannot work under inspection, and never as a static “allow this website” list).
- **Encrypted vault at rest** under a private host folder the container cannot mount.
- **Audit trail** of file and network activity for visibility into what the bridge mediated.

**Honest limits:** Saaridge protects your data **from the agent and its sandbox**. It assumes **you** (the person running Saaridge on your machine) are trusted. It is not a defense against a compromised host computer or a malicious host administrator.

## Product at a glance

Host control plane + locked workspace container + **host-side bridge** (tools, file Data API, HTTP MITM proxy).

|                   |                                                                        |
| ----------------- | ---------------------------------------------------------------------- |
| App               | Saaridge                                                               |
| Bundle ID         | `com.saariv.saaridge`                                                  |
| Workspace image   | `saaridge/saaridge-workspace:0.0.1`                                    |
| Host data root    | `~/Saaridge/`                                                          |
| Default resources | 4g RAM / 2 CPUs / 1g shm / 512m tmp / 1920×1080 (Settings → Resources) |

See [`SHIPPING.md`](./SHIPPING.md) for packaging and installer notes. See [`CONSTRAINTS.md`](./CONSTRAINTS.md) for the non-negotiable mediation rules.

## Guarantees in this build

| Requirement                                 | How it’s enforced                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------ |
| Agent cannot use another agent’s identity   | Per-agent secret token; bridge ignores body `agentId`                                |
| Agent cannot steal sibling token            | Dedicated Linux UID; credentials file `0600` in agent dir `0700`                     |
| Container net blocked except bridge         | iptables allow only host `:7331` (MCP/Data API) and `:7332` (proxy)                  |
| Host project files only via bridge          | No bind-mount of project dirs; `/host` is FUSE → Data API → `~/Saaridge/`            |
| Browse normally inside container via bridge | Chromium → per-agent local auth-proxy → host MITM proxy                              |
| Visibility / transform                      | Async audit JSONL; optional read redact / write block; vault markers; net body hooks |

## Architecture

```text
Container (secure compute)
  ├─ /host (FUSE) ──mediated──► host :7331 /v1/fs/*
  ├─ MCP stdio proxy ──Bearer──► host :7331 tools (same data core)
  └─ Chromium → 127.0.0.1:18xxx auth-proxy ──► host :7332 ──► internet
Host (your machine — data + policies)
  ~/Saaridge/workspaces/<agentId>/   (read-write)
  ~/Saaridge/shared/                 (read-only by default)
  state/private/                     (vault + policies — bridge only)
```

## Docker / FUSE requirements

- Compose passes `/dev/fuse` and `SYS_ADMIN` (plus `apparmor:unconfined` where needed).
- On Docker Desktop, ensure the VM exposes fuse; rebuild the image after pulling these changes.

## Run

**Primary UI:** Electron app — **Settings** (Policies | Microphone | Resources) plus the workspace desktop.

```bash
npm install
npm run app:install   # once
npm run app           # starts host if needed, opens Saaridge window
```

Or install a packaged build from `bin/` (see [`SHIPPING.md`](./SHIPPING.md)): open the DMG/exe/AppImage, ensure Docker Desktop is installed, then launch Saaridge.

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

Auth: `Authorization: Bearer <agent-token>`. Header `X-Saaridge-FS: 1`.

| Method | Path                                | Purpose                 |
| ------ | ----------------------------------- | ----------------------- |
| GET    | `/v1/fs/health`                     | data plane ready        |
| GET    | `/v1/fs/stat?path=`                 | stat                    |
| GET    | `/v1/fs/list?path=`                 | list                    |
| GET    | `/v1/fs/read?path=&offset=&length=` | chunked read            |
| PUT    | `/v1/fs/write?path=&offset=`        | chunked write           |
| POST   | `/v1/fs/mkdir`                      | mkdir                   |
| DELETE | `/v1/fs/path?path=`                 | unlink/rmdir            |
| POST   | `/v1/fs/rename`                     | rename                  |
| GET    | `/v1/audit`                         | recent file + net audit |

## Notes

- Host Mac/Windows browser is unchanged (not forced through Saaridge).
- Paths outside `~/Saaridge/` are denied by default (home is browse-only until you grant write).
- `terminal_exec` stays disabled; host commands do not bypass the bridge.
