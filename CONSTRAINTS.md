# OneBridge hard constraints (non-negotiable)

These rules apply to **all** work in this repository (humans and agents).
If a change conflicts with this file, **this file wins** — redesign the change.

## Guarantee (must never be weakened)

1. **Host → agent text** is always mediated. Reads/lists/writes of host data go only through the Data API / FUSE / MCP file tools and [`host/bridge/control/lib.js`](host/bridge/control/lib.js). The agent must never get a raw bind-mount or host shell bypass (`terminal_exec` stays disabled).

2. **Any network call that carries redacted / vault data** (`vault://…` or equivalent markers) must be fully owned by the bridge:
   - Control library sees the request **before** secrets are resolved.
   - Secrets are attached only on the bridge.
   - The response text is processed by the control library **before** the agent/LLM sees it.
   - Unresolved `vault://` must not reach upstream (deny).

3. **Fail-closed egress:** if the bridge / lock is down, the container has no general internet and no host data plane. Do not reintroduce soft-open iptables (`exit 0` on lock failure).

4. **Editing control policy** happens only in [`host/bridge/control/lib.js`](host/bridge/control/lib.js) (helpers in `control/helpers.js`). Do not scatter redact/allow logic into random tools.

## Explicitly forbidden

- Adding **hostname / URL allowlists or passthrough lists** as the way to “make a site work” (e.g. hard-coding `linkedin.com`, `google.com`, …). That creates blind spots where redacted tokens cannot be detected.
- Disabling the local HTTPS proxy / MITM path for convenience without an automatic, non-URL-list mechanism.
- Giving the agent host shell, raw docker mounts of secrets, or install-time `dockerCp` of secrets into agent-reachable paths.
- Shipping identity “fixes” that skip `control/lib.js` or `vault://` resolution for mediated text.

## Allowed compatibility mechanism (no URL lists)

Sites that break under TLS inspection (Cloudflare, pinning, media CDN TLS fingerprinting, etc.) may use **adaptive passthrough**:

- Default: inspect (MITM) every `CONNECT`.
- If the **client** fails the MITM TLS handshake, we observe a Cloudflare-style challenge under MITM, **or** a media CDN returns 403/401 to the MITM upstream client (content/URL heuristics — not hostnames), the bridge may mark that **registrable domain** for temporary blind passthrough **at runtime only**.
- No checked-in list of site names. No “add LinkedIn to the allow list” PRs.
- **Residual risk (accepted only as temporary):** while a domain is adaptively blind, `vault://` on that domain cannot be seen on the wire. Mitigations that preserve the guarantee:
  - Prefer `vault_http` / bridge-owned fetch for any secretful API.
  - Do not put vault markers into browser navigations to blind domains.
  - Future: in-browser detector that sees plaintext before TLS and forces vault_http / blocks the request.

Auth login breakage should be solved the same adaptive way — not by growing a static passthrough array.

## Non-goals (do not confuse with the guarantee)

- 100% inspection of **all** internet bytes (images, binary, and temporary adaptive-blind domains are out).
- Inventing product behavior inside the framework; product control stays in `control/lib.js`.

## When changing networking / desktop / tools

Before merge, confirm:

- [ ] Host text still goes through control lib.
- [ ] `vault://` still resolves only after control lib; unresolved refs denied.
- [ ] No new static hostname allow/passthrough list.
- [ ] Fail-closed lock still fails closed.
- [ ] Browser still uses the local auth-proxy → host bridge (no direct egress).
