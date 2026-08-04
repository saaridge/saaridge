# Fix discipline (bugs → reliable fix → test)

Read and obey [`CONSTRAINTS.md`](CONSTRAINTS.md) first. If a fix conflicts with it, **redesign** — do not weaken mediation, vault, fail-closed egress, or add static hostname/URL passthrough lists.

## Before writing a fix

1. **Reproduce** with a concrete failure signal (API timeout, black screen, hung `docker exec`, wrong RFB banner, etc.).
2. **Classify** the failure:
   - **Startup** — required dependency missing/down (Docker, host control plane, Xvfb, stream ports, FUSE).
   - **Runtime** — something dies or wedges after boot (x11vnc zombie, FUSE hang, stream disconnect).
   - **One-shot env** — only broken after a manual poke (not enough; still add detection).
3. **Check CONSTRAINTS.md** — especially host text mediation, `vault://`, no URL allowlists, generic (not app-specific) solutions.

## What “fixed” means

A fix is incomplete unless it includes **all** that apply:

| Layer | Requirement |
| --- | --- |
| **Root cause** | Correct the underlying bug (not a sleep, not a hostname exception, not “restart and pray”). |
| **Startup ensure** | Boot / launch paths verify the dependency and start or fail clearly (e.g. Docker via `ensure-docker`, control plane via `launch-mac.sh` / `start-host.sh`, stream via `ensureStreamStack`). |
| **Runtime detect + recover** | While the product is open, detect the bad state and heal or surface a clear error (e.g. desktop `startStreamHeal`, stream-health must not hang forever). |
| **Regression test** | Add or extend a test under `scripts/` that fails on the old bug and passes after the fix. Wire it into `package.json` `test` / a focused `test:*` script when it is cheap enough for CI. |
| **No constraint bypass** | Do not “fix” browsing/login by static MITM passthrough lists or by skipping `control/lib.js`. |

## Docker / container command hygiene

- Prefer `docker exec … bash -c` for health, repair, and tests. **Avoid `bash -lc`** unless you intentionally need a login profile.
- Login shells source `/etc/profile.d/onebridge.sh` → `agent-env.sh`, which may STAT `/host` (FUSE). A wedged FUSE turns stream-health into a **black desktop boot screen**.
- Every `dockerExec` used on a health path must have a **finite `timeoutMs`** and must not block forever on FUSE or RFB `recv`.

## After the fix

1. Add or extend the regression test for this bug.
2. **Run the full suite before you call the work done:** `npm test` from the repo root. Do not mark the task complete, hand off, or stop after only the new focused `test:*` script — the whole `package.json` `test` chain must pass.
3. If a suite needs Docker/`agent-bridge-box` and the box is down, start it (or say clearly what could not run). Do not skip failing tests.
4. If the change touches desktop stream, also confirm `/api/desktop/stream-health` returns quickly (`200`/`503`, not hang).
5. Update this file or the matching rule only when the process itself changes — put product constraints in `CONSTRAINTS.md`.

## Minimal checklist (copy into PR / agent notes)

- [ ] `CONSTRAINTS.md` still holds
- [ ] Startup path ensures the dependency
- [ ] Runtime detection + recovery exists (or explicitly N/A with reason)
- [ ] Regression test added
- [ ] **`npm test` passed** (full suite, not only the new test)
- [ ] No static URL/hostname passthrough; no mediation bypass
