#!/usr/bin/env bash
# Build and package the Kanban Electron app (standalone embedded build).
#   1. Build frontend (Vite → frontend/dist/)
#   2. Build backend  (Nest → backend/dist/, prod node_modules installed)
#   3. Rebuild backend's native modules (better-sqlite3) for Electron's ABI
#   4. Compile desktop's Electron main process
#   5. electron-builder packages everything together
#
# Run from the desktop/ directory:  bash scripts/pack-kanban.sh
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$DESKTOP_DIR/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"
BACKEND_DIR="$ROOT_DIR/backend"

ELECTRON_VERSION="$(node -e "console.log(require('$DESKTOP_DIR/node_modules/electron/package.json').version)")"

echo "[pack-kanban] Building frontend renderer..."
cd "$FRONTEND_DIR"
npm run build

echo "[pack-kanban] Building backend (TS → dist/)..."
cd "$BACKEND_DIR"
npm run build

echo "[pack-kanban] Rebuilding backend native modules for Electron $ELECTRON_VERSION..."
# better-sqlite3 was compiled against Node's ABI by `npm install` — Electron
# uses a different ABI, so it must be rebuilt before packaging.
npx --yes @electron/rebuild --module-dir "$BACKEND_DIR" --version "$ELECTRON_VERSION"

echo "[pack-kanban] Compiling Electron main process..."
cd "$DESKTOP_DIR"
npx tsc -p tsconfig.json

echo "[pack-kanban] Running electron-builder..."
npx electron-builder --config electron-builder.json --publish "${PUBLISH:-never}"

echo "[pack-kanban] Done. Artifacts in: $ROOT_DIR/bin/electron-kanban/"
