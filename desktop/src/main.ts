/**
 * Kanban product — Electron main process.
 *
 * Standalone embedded build:
 *   - Forks the NestJS backend as a child Node (ELECTRON_RUN_AS_NODE=1)
 *     pointed at the active board's `.sqlite` file inside userData.
 *   - Waits for `/api/v1/health`, then logs in as the seeded admin and
 *     pushes the session to the renderer via the existing auth bridge so
 *     no login screen appears in normal desktop use.
 *   - Loads `http://127.0.0.1:<port>/` — the backend serves the React app.
 *
 *   makestudio-kanban://open/...       deep-link protocol (Phase 4)
 *   Ctrl/Cmd+Shift+K                   global show/focus shortcut
 *   System tray + dock badge           Phase 2/3 features
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
  dialog,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { readSession, writeSession, clearSession, AuthSession } from './authStore';
import { loadWindowState, saveWindowState, WindowState } from './windowState';
import { setupUpdater } from './updater';
import * as backend from './backendProcess';
import * as library from './boardLibrary';

process.env.MAKESTUDIO_PRODUCT = process.env.MAKESTUDIO_PRODUCT || 'kanban';

// ── Phase 4: deep-link protocol ───────────────────────────────────────────
const PROTOCOL = 'makestudio-kanban';

if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
    path.resolve(process.argv[1]),
  ]);
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

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

app.on('open-url', (_event, url) => {
  _event.preventDefault();
  handleDeepLink(url);
});

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let unmaximizedBounds: WindowState = { width: 1440, height: 960, maximized: false };

// ── Splash screen HTML (no external assets) ───────────────────────────────
const SPLASH_HTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;background:#111827}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.icon{width:72px;height:72px;background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);
  border-radius:18px;display:flex;align-items:center;justify-content:center;
  font-size:36px;margin-bottom:18px;box-shadow:0 8px 32px rgba(99,102,241,.35)}
h1{color:#f9fafb;font-size:17px;font-weight:600;letter-spacing:-.02em;margin-bottom:8px}
small{color:#94a3b8;font-size:12px;margin-bottom:20px}
.track{width:140px;height:2px;background:#1f2937;border-radius:1px;overflow:hidden}
.bar{height:100%;background:linear-gradient(90deg,#6366f1,#a78bfa);border-radius:1px;
  animation:shimmer 1.4s ease-in-out infinite}
@keyframes shimmer{0%{width:0%;margin-left:0%}40%{width:60%;margin-left:20%}100%{width:0%;margin-left:100%}}
</style></head><body>
<div class="icon">&#x1F4CB;</div><h1>MakeStudio Kanban</h1>
<small id="msg">iniciando…</small>
<div class="track"><div class="bar"></div></div>
</body></html>`;

function getIconPath(): string {
  return path.join(__dirname, '..', 'assets', 'kanban', 'icon.png');
}

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

// ── Backend bootstrap helpers ────────────────────────────────────────────

/** Ensure there is at least one board file in the library and one active. */
function ensureActiveBoard(): library.BoardLibraryEntry {
  const active = library.getActive();
  if (active && fs.existsSync(active.filePath)) return active;
  // Fall back to most recently opened…
  const entries = library.list().filter((e) => fs.existsSync(e.filePath));
  if (entries.length > 0) return library.setActive(entries[0].id)!;
  // …or create a fresh "Meu Kanban" file.
  const fresh = library.create('Meu Kanban');
  return library.setActive(fresh.id)!;
}

/** Log in as the seeded admin against the embedded backend and push the
 *  session to the renderer via the existing auth bridge. */
async function loginSeededAdmin(): Promise<AuthSession | null> {
  const { email, password } = backend.getAdminCredentials();
  const origin = backend.getOrigin();
  return new Promise((resolve) => {
    const body = JSON.stringify({ email, password });
    const url = new URL('/api/v1/auth/email/login', origin);
    const req = http.request(
      {
        method: 'POST',
        host: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            if (json?.token && json?.user) {
              const session: AuthSession = {
                token: json.token,
                refreshToken: json.refreshToken,
                user: json.user,
              };
              writeSession(session);
              resolve(session);
            } else resolve(null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ── Splash window ────────────────────────────────────────────────────────

function createSplash(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 400,
    height: 280,
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

// ── System tray ──────────────────────────────────────────────────────────

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
      void createWindow();
    }
  };

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir MakeStudio Kanban', click: showWindow },
      { type: 'separator' },
      {
        label: 'Sair',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );

  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

// ── Main window ──────────────────────────────────────────────────────────

async function createWindow(): Promise<void> {
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

  let splashDismissed = false;
  const dismissSplash = () => {
    if (splashDismissed) return;
    splashDismissed = true;
    if (!splash.isDestroyed()) splash.close();
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
      if (ws.maximized) mainWindow.maximize();
    }
  };

  mainWindow.webContents.once('did-finish-load', dismissSplash);
  mainWindow.webContents.once('did-fail-load', dismissSplash);
  const splashTimeout = setTimeout(dismissSplash, 30_000);

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

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

  const updateBounds = () => {
    if (mainWindow && !mainWindow.isMaximized() && !mainWindow.isMinimized()) {
      unmaximizedBounds = { ...mainWindow.getBounds(), maximized: false };
    }
  };
  mainWindow.on('resize', updateBounds);
  mainWindow.on('move', updateBounds);

  mainWindow.on('close', (e) => {
    saveWindowState({ ...unmaximizedBounds, maximized: mainWindow!.isMaximized() });
    if (!isQuitting && process.platform !== 'darwin') {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // ── Boot embedded backend pointing at the active board file ────────────
  try {
    const active = ensureActiveBoard();
    await backend.start({ databasePath: active.filePath });
    await backend.waitForHealth();
    await loginSeededAdmin();
  } catch (err) {
    clearTimeout(splashTimeout);
    dismissSplash();
    // eslint-disable-next-line no-console
    console.error('[product:kanban] backend failed to start:', err);
    dialog.showErrorBox(
      'Falha ao iniciar',
      `Não foi possível iniciar o backend embutido.\n\n${(err as Error).message}`,
    );
    app.quit();
    return;
  }

  const url = `${backend.getOrigin()}/`;
  // eslint-disable-next-line no-console
  console.log(`[product:kanban] loading ${url}`);
  mainWindow.loadURL(url).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[product:kanban] failed to load renderer', err);
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

ipcMain.handle('kanban:badge', (_e, count: number) => {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setBadge(count > 0 ? String(count) : '');
  }
});

// Board library — file-per-board model
ipcMain.handle('boardLibrary:list', () => library.list());
ipcMain.handle('boardLibrary:active', () => library.getActive());
ipcMain.handle('boardLibrary:create', (_e, name: string) => library.create(name));
ipcMain.handle('boardLibrary:rename', (_e, id: string, name: string) =>
  library.rename(id, name),
);
ipcMain.handle(
  'boardLibrary:remove',
  (_e, id: string, deleteFile?: boolean) => library.remove(id, deleteFile),
);

/** Open a board file: restart the embedded backend pointing at it, then
 *  re-login the renderer. Returns the fresh auth session for seedAuth. */
ipcMain.handle('boardLibrary:open', async (_e, id: string) => {
  const entry = library.setActive(id);
  if (!entry) throw new Error(`board ${id} not in library`);
  await backend.switchTo(entry.filePath);
  const session = await loginSeededAdmin();
  // Tell the renderer to reload at /kanban so it sees the new file.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(`${backend.getOrigin()}/kanban`).catch(() => {});
  }
  return { entry, session };
});

ipcMain.handle('boardLibrary:import', async () => {
  if (!mainWindow) return null;
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Importar board (.sqlite)',
    filters: [{ name: 'Board', extensions: ['sqlite', 'db'] }],
    properties: ['openFile'],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return library.importFile(res.filePaths[0]);
});

// ── App lifecycle ─────────────────────────────────────────────────────────
app.setName('MakeStudio Kanban');

app.on('before-quit', async () => {
  isQuitting = true;
  await backend.stop();
});

app.whenReady().then(async () => {
  createTray();
  await createWindow();

  const shortcutRegistered = globalShortcut.register('CommandOrControl+Shift+K', () => {
    if (!mainWindow) void createWindow();
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
    if (!mainWindow || mainWindow.isDestroyed()) void createWindow();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  if (process.env.NODE_ENV !== 'development' && mainWindow) {
    setupUpdater(mainWindow);
  }
});

app.on('window-all-closed', () => {
  // tray keeps the app alive
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
