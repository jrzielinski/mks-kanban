/**
 * Kanban product — Electron main process.
 *
 * Loaded by `desktop/main.ts` when `MAKESTUDIO_PRODUCT=kanban`.
 *
 * Features by phase:
 *   Phase 1 — slim BrowserWindow + IPC auth bridge (safeStorage keychain)
 *   Phase 2 — splash screen, window state persistence, system tray,
 *             global shortcut Ctrl/Cmd+Shift+K
 *   Phase 3 — native OS notifications + dock/taskbar badge
 *   Phase 4 — deep links via makestudio-kanban:// protocol
 *
 * URL resolution (in order):
 *   1. KANBAN_TARGET_URL — explicit override (used by dev script)
 *   2. Default dev URL at :3022
 *   3. On-disk build inside extraResources: kanban-app/index.html
 */

import {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
  Notification as ElectronNotification,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { readSession, writeSession, clearSession, AuthSession } from './authStore';
import { loadWindowState, saveWindowState, WindowState } from './windowState';
import { setupUpdater } from './updater';

process.env.MAKESTUDIO_PRODUCT = process.env.MAKESTUDIO_PRODUCT || 'kanban';

// ── Phase 4: deep-link protocol ───────────────────────────────────────────
const PROTOCOL = 'makestudio-kanban';

// Register the custom protocol client BEFORE app.ready.
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
    path.resolve(process.argv[1]),
  ]);
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

// Single-instance lock: on Win/Linux, deep-link URLs arrive as argv of a
// second-instance attempt. We forward to the running instance and quit the new one.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const url = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (url) handleDeepLink(url);
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
}

// macOS: OS delivers the URL via open-url (even before app.ready in packaged builds).
app.on('open-url', (_event, url) => {
  _event.preventDefault();
  handleDeepLink(url);
});

// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_DEV_URL = 'http://127.0.0.1:3022/kanban';
const targetUrl = process.env.KANBAN_TARGET_URL || DEFAULT_DEV_URL;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let unmaximizedBounds: WindowState = { width: 1440, height: 960, maximized: false };

// ── Splash screen HTML (no external assets, loads instantly) ──────────────
const SPLASH_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:100%;height:100%;background:#111827}
  body{
    display:flex;flex-direction:column;
    align-items:center;justify-content:center;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  }
  .icon{
    width:72px;height:72px;
    background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);
    border-radius:18px;
    display:flex;align-items:center;justify-content:center;
    font-size:36px;margin-bottom:18px;
    box-shadow:0 8px 32px rgba(99,102,241,.35);
  }
  h1{color:#f9fafb;font-size:17px;font-weight:600;letter-spacing:-.02em;margin-bottom:28px}
  .track{width:140px;height:2px;background:#1f2937;border-radius:1px;overflow:hidden}
  .bar{
    height:100%;
    background:linear-gradient(90deg,#6366f1,#a78bfa);
    border-radius:1px;
    animation:shimmer 1.4s ease-in-out infinite;
  }
  @keyframes shimmer{
    0%  {width:0%;margin-left:0%}
    40% {width:60%;margin-left:20%}
    100%{width:0%;margin-left:100%}
  }
</style>
</head>
<body>
  <div class="icon">&#x1F4CB;</div>
  <h1>MakeStudio Kanban</h1>
  <div class="track"><div class="bar"></div></div>
</body>
</html>`;

// ── Helpers ────────────────────────────────────────────────────────────────

function getIconPath(): string {
  // dist/main.js → ../assets/kanban/icon.png
  return path.join(__dirname, '..', 'assets', 'kanban', 'icon.png');
}

function resolveProdEntry(): string | null {
  const candidates = [
    // packaged app: extraResources/kanban-app/
    path.join(process.resourcesPath, 'kanban-app', 'index.html'),
    // dev: frontend/dist/ sibling directory
    path.join(__dirname, '..', '..', 'frontend', 'dist', 'index.html'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// ── Phase 4: deep-link handler ────────────────────────────────────────────
// URL format: makestudio-kanban://open/kanban/<boardId>
// The host ("open") is ignored; the pathname maps directly to app routes.
function handleDeepLink(url: string): void {
  try {
    const parsed = new URL(url);
    const appPath = parsed.pathname || '/kanban';
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('kanban:navigate', appPath);
    }
  } catch {
    // eslint-disable-next-line no-console
    console.error('[product:kanban] invalid deep link:', url);
  }
}

// ── Splash window ──────────────────────────────────────────────────────────

function createSplash(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 400,
    height: 260,
    frame: false,
    center: true,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    backgroundColor: '#111827',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SPLASH_HTML)}`);
  return splash;
}

// ── System tray ────────────────────────────────────────────────────────────

function createTray(): void {
  const iconPath = getIconPath();
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip('MakeStudio Kanban');

  const showWindow = () => {
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  };

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir MakeStudio Kanban', click: showWindow },
      { type: 'separator' },
      { label: 'Sair', click: () => { isQuitting = true; app.quit(); } },
    ]),
  );

  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

// ── Main window ────────────────────────────────────────────────────────────

function createWindow(): void {
  const ws = loadWindowState();
  unmaximizedBounds = { ...ws };

  const splash = createSplash();
  const preloadPath = path.join(__dirname, 'preload.js');

  mainWindow = new BrowserWindow({
    x: ws.x,
    y: ws.y,
    width: ws.width,
    height: ws.height,
    minWidth: 1024,
    minHeight: 720,
    show: false,
    title: 'MakeStudio Kanban',
    backgroundColor: '#0C0A08',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });

  if (process.platform !== 'darwin') {
    mainWindow.setMenuBarVisibility(false);
  }

  // ── Splash lifecycle ─────────────────────────────────────────────────────
  let splashDismissed = false;
  let splashTimeout: ReturnType<typeof setTimeout>;

  const dismissSplash = () => {
    if (splashDismissed) return;
    splashDismissed = true;
    clearTimeout(splashTimeout);
    if (!splash.isDestroyed()) splash.close();
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
      if (ws.maximized) mainWindow.maximize();
    }
  };

  mainWindow.webContents.once('did-finish-load', dismissSplash);
  mainWindow.webContents.once('did-fail-load', dismissSplash);
  splashTimeout = setTimeout(dismissSplash, 10_000);

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // ── Logging ──────────────────────────────────────────────────────────────
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    // eslint-disable-next-line no-console
    console.error('[product:kanban] renderer crashed:', details);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    // eslint-disable-next-line no-console
    console.error(`[product:kanban] did-fail-load: ${code} ${desc} (${url})`);
  });
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = level === 3 ? 'ERROR' : level === 2 ? 'WARN' : 'LOG';
    // eslint-disable-next-line no-console
    console.log(`[renderer:${tag}] ${message}  (${sourceId}:${line})`);
  });

  // ── Window state tracking ─────────────────────────────────────────────────
  const updateBounds = () => {
    if (mainWindow && !mainWindow.isMaximized() && !mainWindow.isMinimized()) {
      unmaximizedBounds = { ...mainWindow.getBounds(), maximized: false };
    }
  };
  mainWindow.on('resize', updateBounds);
  mainWindow.on('move', updateBounds);

  // ── Close: persist state + minimize-to-tray on Win/Linux ─────────────────
  mainWindow.on('close', (e) => {
    saveWindowState({ ...unmaximizedBounds, maximized: mainWindow!.isMaximized() });
    if (!isQuitting && process.platform !== 'darwin') {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // ── Load the renderer ─────────────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log(`[product:kanban] loading ${targetUrl}`);
  mainWindow
    .loadURL(targetUrl)
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[product:kanban] loadURL failed, trying on-disk entry', err?.message);
      const prodEntry = resolveProdEntry();
      if (prodEntry && mainWindow) return mainWindow.loadFile(prodEntry);
      throw new Error(
        'kanban entry not reachable: Vite at :3022 is down and no frontend/dist/index.html on disk',
      );
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[product:kanban] failed to load any entry', err);
    });
}

// ── IPC handlers ──────────────────────────────────────────────────────────

// Phase 1 — auth bridge
ipcMain.handle('kanban:auth:get', () => readSession());
ipcMain.handle('kanban:auth:set', (_e, session: AuthSession) => writeSession(session));
ipcMain.handle('kanban:auth:clear', () => clearSession());

// Phase 3 — native OS notifications
ipcMain.handle('kanban:notify', (_e, { title, body }: { title: string; body: string }) => {
  if (!ElectronNotification.isSupported()) return;
  const n = new ElectronNotification({ title, body });
  n.on('click', () => {
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
  n.show();
});

// Phase 3 — dock/taskbar badge
ipcMain.handle('kanban:badge', (_e, count: number) => {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setBadge(count > 0 ? String(count) : '');
  }
  // Windows overlay icon omitted for now (requires nativeImage generation).
});

// ── App lifecycle ─────────────────────────────────────────────────────────
app.setName('MakeStudio Kanban');

app.on('before-quit', () => { isQuitting = true; });

app.whenReady().then(() => {
  createTray();
  createWindow();

  // Global shortcut: Ctrl/Cmd+Shift+K → show/focus
  const shortcutRegistered = globalShortcut.register('CommandOrControl+Shift+K', () => {
    if (!mainWindow) createWindow();
    else {
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
  if (!shortcutRegistered) {
    // eslint-disable-next-line no-console
    console.warn('[product:kanban] CommandOrControl+Shift+K already in use by another app');
  }

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    else { mainWindow.show(); mainWindow.focus(); }
  });

  // Phase 5 — auto-updater (production only)
  if (process.env.NODE_ENV !== 'development' && mainWindow) {
    setupUpdater(mainWindow);
  }
});

app.on('window-all-closed', () => {
  // Intentionally empty — tray keeps the app alive.
  // Quit only happens via tray → "Sair" (sets isQuitting = true → app.quit()).
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
