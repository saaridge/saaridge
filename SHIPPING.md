# Saaridge productionization checklist

Goal: strangers install Saaridge and get a mediated desktop without `npm` / `docker compose` by hand.

**Product (locked for alpha `0.0.1`)**

| | |
|---|---|
| App name | Saaridge |
| Bundle ID | `com.saariv.saaridge` |
| Docker Hub user | `saaridge` |
| Workspace image | `saaridge/saaridge-workspace:0.0.1` |
| Host data root | `~/Saaridge/` |
| License | Apache 2.0 |
| Channel | alpha |

---

## 0. Product / release decisions

- [x] Name, bundle id, registry user, version `0.0.1`, Apache 2.0, alpha channel
- [ ] Update channel policy (alpha-only vs later stable)
- [ ] Support bar for v1: **Mac first**, then Windows, then Linux host
- [ ] Privacy / ToS blurb for first run (host is trusted operator — see `CONSTRAINTS.md`)

---

## 1. Workspace Docker image (publish)

- [x] Image name versioned: `saaridge/saaridge-workspace:0.0.1` (compose + `host/lib/brand.js`)
- [x] Local/dev: adopt legacy `agent-bridge-box:local` via retag; `--pull never` so unpublished tags are not pulled from Hub
- [x] Hub publish (current arch): `saaridge/saaridge-workspace:0.0.1` + `:alpha` (see `bin/docker-push.log`)
- [ ] CI: `docker buildx` for **`linux/amd64` + `linux/arm64`** (`SAARIDGE_DOCKER_BUILDX=1 npm run ship`)
- [x] Packaged installs **pull** the image (no local build / legacy retag); pull-tested via `scripts/ship/test-installer-pull.sh`
- [ ] Image = runtime only (desktop, FUSE client, auth-proxy, lock) — **not** host policy/vault
- [ ] Document required caps/devices: `/dev/fuse`, `NET_ADMIN`, `SYS_ADMIN`, ports `6081–6083`
- [ ] Size budget / layer cleanup; track image size
- [ ] Smoke: pull on **Intel** and **Apple Silicon**

---

## 2. Host bridge (ships with the app)

- [x] Control plane `:3847`, bridge `:7331`, MITM `:7332`, FS IPC `:7333`
- [x] Single-instance host supervisor (`scripts/start-host.sh` + mkdir lock; macOS has no `flock`)
- [x] App start resets fighting supervisors / frees ports, then waits for branded health
- [x] Policy + vault under `state/private/`
- [x] Default mediated roots under `~/Saaridge/`
- [x] Bundle Node host inside Electron package (users never run `npm start`) — `build/ship-root` → `extraResources/saaridge-root`
- [x] Health gates before desktop: Docker → image pull → container → stream-health
- [x] Confirm mediation stays on host in packaged builds (host runs on Mac/Win/Linux via Electron-as-Node)

---

## 3. Workspace resources (defaults + user customization)

Ship sensible defaults and let users change them in **Settings → Resources** (already implemented for dev).

### Default resources (alpha)

Defined in `host/lib/resources.js` → `DEFAULT_RESOURCES`:

| Knob | Default |
|---|---|
| Memory (`mem_limit`) | `4g` |
| CPUs | `2` |
| Shared memory (`shm_size`) | `1g` |
| `/tmp` tmpfs | `512m` |
| Display (`RESOLUTION`) | `1920x1080x24` |

Presets offered in UI: memory `1g–16g`, CPUs `1–8`, shm `512m–2g`, tmpfs `256m–2g`, resolutions through `3840x2160x24`.

### Checklist

- [x] Persist prefs: `state/private/resources.json`
- [x] Apply via generated `docker-compose.resources.yml` + `compose up --force-recreate`
- [x] Settings pane: Policies | Microphone | **Resources** | API key
- [x] APIs: `GET/POST /api/resources`, `POST /api/resources/apply`
- [ ] Packaged app: same Resources pane + recreate works without repo checkout
- [ ] First-run: show defaults and optional “Customize resources” before first workspace start (or deep-link Settings → Resources)
- [ ] Docs: changing resources **restarts** the workspace; limits cannot exceed **Docker Desktop → Resources**
- [ ] QA matrix: apply each default + one higher preset on Mac arm64; confirm `docker inspect` shows mem/cpus/shm and desktop resolution

---

## 4. Desktop app packaging (Electron)

### Shared

- [x] `desktop/package.json`: `productName` Saaridge, `appId` `com.saariv.saaridge`, version `0.0.1`, electron-builder stubs
- [x] Install **electron-builder** and produce artifacts under **`bin/`** (gitignored)
- [x] Mac **arm64** + **x64** DMG/zip
- [x] Windows **x64** NSIS/portable
- [x] Linux **x64** + **arm64** AppImage + deb
- [ ] Developer ID **sign** + **notarize** / Authenticode (unsigned alpha today)
- [ ] App owns: window, Settings (incl. Resources), stream, first-run wizard
- [ ] Replace Mac-only `launch-mac.sh` with cross-platform “ensure deps → start host → open UI”
- [ ] Auto-update (electron-updater + signed releases)
- [ ] Crash reporting / logs folder documented (`/tmp/saaridge-host.log`, app userData)

### macOS

- [ ] Build **arm64** + **x64** (or universal)
- [ ] `.dmg` and/or `.pkg`
- [ ] Developer ID **sign** + **notarize** + staple
- [ ] First-run: detect Docker Desktop; guide install if missing

### Windows

- [ ] Build **x64** (arm64 later)
- [ ] NSIS or MSIX; Authenticode **sign**
- [ ] Require Docker Desktop (WSL2); clear error if missing
- [ ] Paths under `%USERPROFILE%\Saaridge\`

### Linux (host)

- [ ] AppImage and/or `.deb`
- [ ] Document Docker Engine dependency

---

## 5. First-run / reliability UX

- [ ] Wizard: welcome → Docker check → pull/retag image (progress) → **resources summary (defaults + Customize)** → start workspace → open stream
- [x] Remount/heal FUSE and stream (watchdog / ensure-stream)
- [x] Legacy container migrate (`agent-bridge-box` → `saaridge-box`)
- [ ] Offline / pull-failure messaging
- [ ] “Reset workspace” / “Repair Docker” / “Restart control plane” actions
- [ ] Don’t require cloning this git repo

---

## 6. CI / release pipeline

- [ ] Tag → build & push multi-arch image `saaridge/saaridge-workspace:<ver>`
- [ ] Tag → build Mac / Windows / Linux installers
- [ ] Mac notarization on CI
- [ ] Attach artifacts + SHA256 to GitHub Releases (or site)
- [ ] Smoke: fresh VM per OS/arch → install → stream loads → list `/host/workspaces` → mediated read → **Settings → Resources Apply** recreates cleanly

---

## 7. Security / constraints (do not drop)

- [ ] Vault + policies only on host; private dir permissions
- [ ] No shipping `vault.key` in the image
- [ ] No static URL allowlists to “make installers work”
- [ ] Fail-closed egress still default in container
- [ ] Host trust assumption documented for users
- [ ] Obey `CONSTRAINTS.md` / mediation guarantee

---

## 8. Docs for users

- [ ] System requirements (Docker, disk, RAM — note default workspace **4g / 2 CPUs**)
- [ ] Install steps per OS
- [ ] “What gets installed” (app + image + `~/Saaridge` + Settings resources)
- [ ] How to change Resources and what Apply does
- [ ] Uninstall / data wipe
- [ ] Troubleshooting: Docker not running, control plane timeout, FUSE, black stream, blank login

---

## Suggested order of work

1. Publish multi-arch **image** `saaridge/saaridge-workspace:0.0.1` (stop relying on local retag alone)
2. **Mac DMG** bundling host + pulls image; Resources pane works packaged
3. First-run wizard including **defaults + customize resources**
4. Auto-update + notarization
5. **Windows** installer
6. **Linux** AppImage/deb
7. Store pages later (Docker/FUSE fights App Store rules)

---

## Done when

A stranger on Intel Windows and Apple Silicon Mac can:

1. Download the installer  
2. Install without Terminal  
3. Open Saaridge (optionally tweak Resources from defaults)  
4. See the mediated desktop  
5. Get host-side redaction/vault behavior  

…with Docker as the only extra system dependency for v1.
