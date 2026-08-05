#!/usr/bin/env bash
# Stage a self-contained tree for Electron extraResources (saaridge-root).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-$ROOT/build/ship-root}"
POLICY_SRC="${SAARIDGE_POLICY_ENGINE:-$ROOT/../ai-policy-engine}"

echo "[ship] staging $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"

# Core runtime (no container sources required when image is pulled from Hub).
rsync -a \
  --exclude node_modules \
  --exclude state \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  "$ROOT/host" "$OUT/"

rsync -a \
  --exclude node_modules \
  "$ROOT/scripts" "$OUT/"

cp "$ROOT/docker-compose.yml" "$OUT/"
cp "$ROOT/LICENSE" "$OUT/" 2>/dev/null || true
cp "$ROOT/package.json" "$OUT/package.json"

echo "[ship] npm install --omit=dev in ship-root"
# Fix node argv for production package.json rewrite
node - "$OUT" "$POLICY_SRC" <<'NODE'
const fs = require("fs");
const path = require("path");
const out = process.argv[2];
const policySrc = process.argv[3];
const pkg = JSON.parse(fs.readFileSync(path.join(out, "package.json"), "utf8"));
const vendor = path.join(out, "vendor", "ai-policy-engine");
fs.mkdirSync(path.join(vendor, "packages"), { recursive: true });
for (const name of ["core", "algorithms"]) {
  const src = path.join(policySrc, "packages", name);
  if (!fs.existsSync(src)) {
    console.error(`[ship] missing ${src} — set SAARIDGE_POLICY_ENGINE`);
    process.exit(1);
  }
  fs.cpSync(src, path.join(vendor, "packages", name), { recursive: true });
}
pkg.dependencies = {
  ...pkg.dependencies,
  "@ai-policy-engine/algorithms": "file:./vendor/ai-policy-engine/packages/algorithms",
  "@ai-policy-engine/core": "file:./vendor/ai-policy-engine/packages/core",
};
delete pkg.devDependencies;
fs.writeFileSync(path.join(out, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
console.log("[ship] wrote production package.json");
NODE

(cd "$OUT" && npm install --omit=dev --no-audit --no-fund)

# Compose needs a Dockerfile context for local build fallback; include thin pointer.
mkdir -p "$OUT/container"
if [[ -f "$ROOT/container/Dockerfile" ]]; then
  # Full Dockerfile + needed build context is large; for alpha pull-from-Hub is primary.
  # Keep Dockerfile so `compose build` still works for contributors with the full repo
  # when they point SAARIDGE_ROOT at the checkout. Packaged apps set SAARIDGE_PREFER_PULL=1.
  rsync -a \
    --exclude hostfs-rust/target \
    --exclude '__pycache__' \
    --exclude '*.pyc' \
    "$ROOT/container/" "$OUT/container/"
fi

# Marker for packaged detection
cat >"$OUT/SHIP_ROOT.json" <<EOF
{
  "name": "saaridge",
  "version": "0.0.1",
  "channel": "alpha",
  "image": "saaridge/saaridge-workspace:0.0.1"
}
EOF

echo "[ship] staged $(du -sh "$OUT" | awk '{print $1}')"
