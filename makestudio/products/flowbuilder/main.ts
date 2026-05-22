/**
 * Flow product — Electron main process.
 *
 * Loaded by `desktop/main.ts` when `MAKESTUDIO_PRODUCT=flowbuilder` (the
 * shell entry-point handles the polyfill + tsx/cjs registration before
 * dispatching here). This product is intentionally lightweight: it does
 * NOT boot the agent core, register IPC handlers, or import anything
 * from `agent/src/repl/*`. It is just an Electron BrowserWindow over the
 * slim flow-only frontend bundle (`flow-only.html` →
 * `src/flow-only/main.tsx` → `FlowOnlyApp`).
 *
 * URL resolution (in order):
 *   1. FLOWBUILDER_TARGET_URL — explicit override (used by dev script).
 *   2. Vite dev server at :3021 (default in development).
 *   3. On-disk build: flowbuilder/dist-flow-only/flow-only.html.
 */

import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

const DEFAULT_DEV_URL = 'http://127.0.0.1:3021/flow-engine';
const targetUrl = process.env.FLOWBUILDER_TARGET_URL || DEFAULT_DEV_URL;

/**
 * In dev we always have a target URL pointing at Vite. In prod packaging
 * (electron-builder), we'd ship `flow-only.html` from the slim build
 * inside the asar; this resolver finds it relative to the repo. For now
 * (dev-only) the URL above wins.
 */
function resolveProdEntry(): string | null {
  const candidates = [
    path.join(__dirname, '..', '..', '..', '..', '..', '..', 'flowbuilder', 'dist-flow-only', 'flow-only.html'),
    path.join(__dirname, '..', '..', '..', '..', '..', 'flowbuilder', 'dist-flow-only', 'flow-only.html'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 720,
    title: 'MakeStudio Flow',
    backgroundColor: '#0C0A08',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });

  if (process.platform !== 'darwin') {
    mainWindow.setMenuBarVisibility(false);
  }

  // Open DevTools on launch in dev so renderer errors are visible
  // immediately — white-screen with no info is the worst debugging UX.
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Pipe renderer console + lifecycle errors into the dev launcher's
  // stdout so we don't have to ask the user to manually open DevTools.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    // eslint-disable-next-line no-console
    console.error('[product:flowbuilder] renderer crashed:', details);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    // eslint-disable-next-line no-console
    console.error(`[product:flowbuilder] did-fail-load: ${code} ${desc} (${url})`);
  });
  mainWindow.webContents.on(
    'console-message',
    (_e, level, message, line, sourceId) => {
      const tag = level === 3 ? 'ERROR' : level === 2 ? 'WARN' : 'LOG';
      // eslint-disable-next-line no-console
      console.log(`[renderer:${tag}] ${message}  (${sourceId}:${line})`);
    },
  );

  // Dev: load Vite at :3021. Prod packaging: fall through to the on-disk
  // dist-flow-only/flow-only.html when Vite isn't reachable.
  // eslint-disable-next-line no-console
  console.log(`[product:flowbuilder] loading ${targetUrl}`);
  mainWindow
    .loadURL(targetUrl)
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[product:flowbuilder] loadURL failed, trying on-disk entry', err?.message);
      const prodEntry = resolveProdEntry();
      if (prodEntry && mainWindow) {
        return mainWindow.loadFile(prodEntry);
      }
      throw new Error(
        'flow-only entry not reachable: Vite at :3021 is down and no dist-flow-only/flow-only.html on disk',
      );
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[product:flowbuilder] failed to load any entry', err);
    });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.setName('MakeStudio Flow');

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
