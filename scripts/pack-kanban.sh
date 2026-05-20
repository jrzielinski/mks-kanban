#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP_DIR="$ROOT_DIR/desktop"
AGENT_DIR="$ROOT_DIR/../gptapi/agent"
BUILD_DIR="$DESKTOP_DIR/build"

echo "── MKS Kanban + MKS-CODE Pack ──────────────────────"
echo "Root:      $ROOT_DIR"
echo "Desktop:   $DESKTOP_DIR"
echo "Agent:     $AGENT_DIR"
echo ""

# 1. Build the MKS-CODE agent
echo "▸ Building MKS-CODE agent..."
cd "$AGENT_DIR"
if [ ! -d "node_modules" ]; then
  npm install --silent 2>/dev/null
fi
npx swc src -d dist --strip-leading-paths 2>/dev/null || npx tsc --noEmit false 2>/dev/null || npm run build
echo "  ✓ agent dist ready"

# 2. Copy agent dist into desktop build resources
echo "▸ Copying agent dist to desktop resources..."
mkdir -p "$BUILD_DIR/agent"
cp -r "$AGENT_DIR/dist" "$BUILD_DIR/agent/"
cp "$AGENT_DIR/package.json" "$BUILD_DIR/agent/"
echo "  ✓ agent copied"

# 3. Build desktop TypeScript
echo "▸ Building desktop TypeScript..."
cd "$DESKTOP_DIR"
npx tsc --noEmit --pretty 2>&1 || true
npx tsc --pretty 2>&1 || {
  echo "  ✗ tsc failed — trying npx swc"
  npx swc src -d dist --strip-leading-paths
}
echo "  ✓ desktop compiled"

# 4. Package with electron-builder
echo "▸ Running electron-builder..."
npx electron-builder --config electron-builder.json "$@"
echo ""

echo "── Done ────────────────────────────────────────────"
echo "Artifacts in: $DESKTOP_DIR/dist/"
ls -lh "$DESKTOP_DIR/dist/"*.{dmg,exe,AppImage,deb,rpm} 2>/dev/null || echo "(check dist/ for output)"
