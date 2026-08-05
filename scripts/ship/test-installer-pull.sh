#!/usr/bin/env bash
# Simulate first-run installer: no local workspace images, must Hub-pull.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
IMAGE="saaridge/saaridge-workspace:0.0.1"

echo "[pull-test] removing local workspace images…"
docker rmi "$IMAGE" 2>/dev/null || true
docker rmi saaridge/saaridge-workspace:alpha 2>/dev/null || true
# Also remove legacy tag so adoptLegacyImage cannot cheat
docker rmi agent-bridge-box:local 2>/dev/null || true

echo "[pull-test] images gone?"
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "[pull-test] FAIL: $IMAGE still present" >&2
  exit 1
fi

echo "[pull-test] ensureImage via host with SAARIDGE_PREFER_PULL=1…"
SAARIDGE_PREFER_PULL=1 SAARIDGE_PACKAGED=1 node --input-type=module <<'JS'
import { ensureImage, IMAGE_NAME } from "./host/lib/docker.js";
const r = await ensureImage();
console.log(JSON.stringify({ IMAGE_NAME, ...r }, null, 2));
if (!r.ok || !r.pulled) {
  console.error("[pull-test] FAIL: expected ok+pulled");
  process.exit(1);
}
JS

docker image inspect "$IMAGE" >/dev/null
echo "[pull-test] OK — image pulled from Hub as installer would"
