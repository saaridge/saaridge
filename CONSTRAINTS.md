# OneBridge hard constraints (non-negotiable)

These rules apply to **all** work in this repository (humans and agents).
If a change conflicts with this file, **this file wins** — redesign the change.

## Guarantee (must never be weakened)

1. **Host → agent text** is always mediated. Reads/lists/writes of host data go only through the Data API / FUSE / MCP file tools and [`host/bridge/control/lib.js`](host/bridge/control/lib.js). The agent must never get a raw bind-mount or host shell bypass (`terminal_exec` stays disabled).

2. **Any network call that carries redacted / vault data** (`vault://…` or equivalent markers) must be fully owned by the bridge (**MEDIATE**):
   - Control library sees the request **before** secrets are resolved.
   - Secrets are attached only on the bridge.
   - The **upstream** TCP/TLS call is opened by the bridge (`vault_http` / `/v1/vault/fetch` / MITM resolve path) — never by the container over blind TUNNEL.
   - The response text is processed by the control library **before** the agent/LLM sees it.
   - Unresolved `vault://` must not reach upstream (deny).
   - Pre-TLS detectors: auth-proxy cleartext scan, `curl`/`wget` host-bin shims, MCP `vault_http`. `CONNECT` with `vault://` in URL/headers is denied.

3. **Vault ciphertext + keys are bridge-only** (`state/private/`, mode `0700`/`0600`, AES-256-GCM OneCLI wire format). Agents see `vault://id` markers and metadata only — never plaintext, never ciphertext, never the key. Data API / FUSE must deny the private vault path. Do not mount the store into the container.

4. **Fail-closed egress:** if the bridge / lock is down, the container has no general internet and no host data plane. Do not reintroduce soft-open iptables (`exit 0` on lock failure). Lock must cover **IPv6** (`ip6tables` DROP) and pin **DNS to resolvers in `/etc/resolv.conf`** (not open `:53` to the world).

5. **Editing control policy** happens only in [`host/bridge/control/lib.js`](host/bridge/control/lib.js) (helpers in `control/helpers.js`). Do not scatter redact/allow logic into random tools.

## Explicitly forbidden

- Adding **hostname / URL allowlists or passthrough lists** as the way to “make a site work” (e.g. hard-coding `linkedin.com`, `google.com`, …). That creates blind spots where redacted tokens cannot be detected.
- Disabling the local HTTPS proxy / MITM path for convenience without an automatic, non-URL-list mechanism.
- Giving the agent host shell, raw docker mounts of secrets, or install-time `dockerCp` of secrets into agent-reachable paths.
- Shipping identity “fixes” that skip `control/lib.js` or `vault://` resolution for mediated text.
- Returning vault ciphertext or plaintext secret values on any agent-facing API.

## Allowed compatibility mechanism (no URL lists)

Sites that break under TLS inspection (Cloudflare, pinning, media CDN TLS fingerprinting, etc.) may use **adaptive passthrough** (**TUNNEL** for non-redacted traffic only):

- Default: inspect (MITM) every `CONNECT`.
- If the **client** fails the MITM TLS handshake, we observe a Cloudflare-style challenge under MITM, **or** a media CDN returns 403/401 to the MITM upstream client (content/URL heuristics — not hostnames), the bridge may mark that **registrable domain** for temporary blind passthrough **at runtime only**.
- No checked-in list of site names. No “add LinkedIn to the allow list” PRs.
- **Vault-bearing connections must not enqueue adaptive blind.** Clear adaptive marks when vault is resolved. Secretful calls use `vault_http` / mediate path.
- **Residual risk (accepted):** while a domain is adaptively blind, `vault://` inside HTTPS bodies cannot be seen on the wire. Mitigations that preserve the guarantee:
  - Prefer `vault_http` / bridge-owned fetch / curl shim for any secretful API.
  - Do not put vault markers into browser navigations to blind domains.
  - Auth-proxy / shims force MEDIATE when markers are visible in cleartext.

Auth login breakage should be solved the same adaptive way — not by growing a static passthrough array.

## Trusted computing base / residual breaks (honest)

Absolute guarantees apply against the **container + agent + blind proxy path** as adversary. The following are **out of scope** (bridge/host are trusted):

- Compromised host kernel, bridge binary, or `state/private/vault.key`.
- Plaintext secrets typed by the agent **without** `vault://` markers and sent over TUNNEL/MITM.
- Browser HTTPS that embeds `vault://` without a pre-TLS shim (policy: don’t; deny if seen on MITM; invisible inside adaptive TUNNEL).
- Container root with `NET_ADMIN` undoing iptables (watchdog / capability drop is follow-up hardening).

## Non-goals (do not confuse with the guarantee)

- 100% inspection of **all** internet bytes (images, binary, and temporary adaptive-blind domains are out).
- Inventing product behavior inside the framework; product control stays in `control/lib.js`.
- Dedicated bridge OS user / OS keychain (v1 uses file ACL + AES-GCM under `state/private/`).

## When changing networking / desktop / tools

Before merge, confirm:

- [ ] Host text still goes through control lib.
- [ ] `vault://` still resolves only after control lib; unresolved refs denied; upstream is bridge-owned for vault traffic.
- [ ] Vault on disk is ciphertext only; agent APIs never return values/ciphertext.
- [ ] No new static hostname allow/passthrough list.
- [ ] Fail-closed lock still fails closed (IPv4 + IPv6 + DNS pin).
- [ ] Browser still uses the local auth-proxy → host bridge (no direct egress).
- [ ] Adaptive TUNNEL is never used to carry detectable vault markers.
