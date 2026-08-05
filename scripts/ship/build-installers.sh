#!/usr/bin/env bash
# Ship Saaridge: push workspace image FIRST, then build installers into bin/.
# Packaged apps pull the image from Hub (no local build / legacy retag).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./desktop/package.json').version")"
BIN="$ROOT/bin"
SHIP_ROOT="$ROOT/build/ship-root"
IMAGE="saaridge/saaridge-workspace:${VERSION}"

mkdir -p "$BIN"
echo "[ship] version=$VERSION → $BIN"

###############################################################################
# 1) Docker Hub publish FIRST (required before installer pull-test)
###############################################################################
echo "[ship] 1/5 push workspace image $IMAGE"
docker tag agent-bridge-box:local "$IMAGE" 2>/dev/null || true
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "[ship] building local image $IMAGE (no local tag found)…"
  docker compose build agent-box
fi

echo "[ship] docker push $IMAGE …"
docker push "$IMAGE" 2>&1 | tee "$BIN/docker-push.log"
docker tag "$IMAGE" saaridge/saaridge-workspace:alpha
docker push saaridge/saaridge-workspace:alpha 2>&1 | tee -a "$BIN/docker-push.log"

# Verify Hub can serve the tag
echo "[ship] verifying Hub pull works…"
docker rmi "$IMAGE" 2>/dev/null || true
docker pull "$IMAGE" 2>&1 | tee "$BIN/docker-pull-verify.log"
docker image inspect "$IMAGE" >/dev/null
echo "pushed_and_verified=$IMAGE" | tee "$BIN/docker-image.txt"

if [[ "${SAARIDGE_DOCKER_BUILDX:-0}" == "1" ]]; then
  echo "[ship] multi-arch buildx (amd64+arm64)…"
  docker buildx create --name saaridge-builder --driver docker-container --use 2>/dev/null \
    || docker buildx use saaridge-builder 2>/dev/null || true
  docker buildx build \
    --platform linux/amd64,linux/arm64 \
    -f container/Dockerfile \
    -t "$IMAGE" \
    -t saaridge/saaridge-workspace:alpha \
    --push \
    "$ROOT" 2>&1 | tee "$BIN/docker-buildx.log"
fi

###############################################################################
# 2) Stage packaged host root + electron-builder
###############################################################################
echo "[ship] 2/5 prepare ship-root"
bash "$ROOT/scripts/ship/prepare-ship-root.sh" "$SHIP_ROOT"

echo "[ship] 3/5 install electron-builder"
npm --prefix desktop install --no-audit --no-fund

###############################################################################
# 3) Installers
###############################################################################
echo "[ship] 4/5 electron installers → $BIN"
cd "$ROOT/desktop"
set +e
npx electron-builder --mac --arm64 --x64 --publish never 2>&1 | tee "$BIN/build-mac.log"
MAC_RC=${PIPESTATUS[0]}
npx electron-builder --win --x64 --publish never 2>&1 | tee "$BIN/build-win.log"
WIN_RC=${PIPESTATUS[0]}
npx electron-builder --linux --x64 --arm64 --publish never 2>&1 | tee "$BIN/build-linux.log"
LINUX_RC=${PIPESTATUS[0]}
set -e
cd "$ROOT"

###############################################################################
# 4) Installer pull-test (delete local images so ensure must Hub-pull)
###############################################################################
echo "[ship] 5/5 pull-test (delete local images, then host ensure with PREFER_PULL=1)"
bash "$ROOT/scripts/ship/test-installer-pull.sh" 2>&1 | tee "$BIN/pull-test.log"
PULL_RC=${PIPESTATUS[0]:-0}

(
  cd "$BIN"
  rm -f SHA256SUMS.txt
  find . -maxdepth 3 -type f \( \
    -name 'Saaridge-*' -o -name '*.dmg' -o -name '*.exe' -o -name '*.AppImage' \
    -o -name '*.deb' -o -name '*.zip' \
  \) ! -name '*.log' ! -name 'SHA256SUMS.txt' ! -name 'README.md' \
    | sed 's|^\./||' | sort -u | while read -r f; do
      shasum -a 256 "$f" >> SHA256SUMS.txt
    done
)

cat >"$BIN/README.md" <<EOF
# Saaridge ${VERSION} (alpha) installers

Gitignored build outputs. End users only need an installer + Docker Desktop.

## First launch (automatic)

1. App checks Docker — if missing, shows an error to install Docker Desktop.
2. If Docker is installed but stopped, app starts it and waits.
3. App **pulls** \`${IMAGE}\` from Docker Hub (no manual docker commands).
4. Starts workspace with default resources (4g / 2 CPUs / …); user can change in Settings → Resources.

## Build results

| Step | Exit |
|------|------|
| mac | ${MAC_RC} |
| win | ${WIN_RC} |
| linux | ${LINUX_RC} |
| pull-test | ${PULL_RC} |

See \`docker-image.txt\`, \`pull-test.log\`.
EOF

echo "[ship] done"
ls -lah "$BIN" | head -60
echo "mac=$MAC_RC win=$WIN_RC linux=$LINUX_RC pull=$PULL_RC"
