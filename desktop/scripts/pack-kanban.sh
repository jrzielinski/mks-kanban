#!/usr/bin/env bash
# Build and package the Kanban Electron app.
# Run from the desktop/ directory: bash scripts/pack-kanban.sh
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_DIR="$DESKTOP_DIR/../frontend"

echo "[pack-kanban] Building frontend renderer..."
cd "$FRONTEND_DIR"
npm run build

echo "[pack-kanban] Compiling Electron main process..."
cd "$DESKTOP_DIR"
npx tsc -p tsconfig.json

echo "[pack-kanban] Running electron-builder..."
npx electron-builder --config electron-builder.json --publish "${PUBLISH:-never}"

echo "[pack-kanban] Done. Artifacts in: $(cd "$DESKTOP_DIR" && pwd)/../bin/electron-kanban/"
