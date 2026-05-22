/**
 * Kanban product — Electron main process.
 *
 * Loaded by `desktop/main.ts` when `MAKESTUDIO_PRODUCT=kanban`.
 *
 * Zero infrastructure — no Docker, Postgres, Redis or identity server.
 * Forks mks-kanban NestJS backend with better-sqlite3; auto-login via
 * a local HS256 JWT secret stored in the OS keychain.
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
  shell,
  safeStorage,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { readSession, writeSession, clearSession, AuthSession } from './authStore';
import { loadWindowState, saveWindowState, WindowState } from './windowState';
import { setupUpdater } from './updater';
import * as backend from './backendProcess';
import * as library from './boardLibrary';

process.env.MAKESTUDIO_PRODUCT = process.env.MAKESTUDIO_PRODUCT || 'kanban';

const PROTOCOL = 'makestudio-kanban';

if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_e: Electron.Event, argv: string[]) => {
    const url = argv.find((a: string) => a.startsWith(`${PROTOCOL}://`));
    if (url) handleDeepLink(url);
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.on('open-url', (_event: Electron.Event, url: string) => {
  _event.preventDefault();
  handleDeepLink(url);
});

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let unmaximizedBounds: WindowState = { width: 1440, height: 960, maximized: false };

// ── JWT secret (local HS256, no identity server) ──────────────────────────

function secretFile(): string {
  return path.join(app.getPath('userData'), 'kanban-secret.json');
}

function getOrCreateJwtSecret(): string {
  const file = secretFile();
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file);
      return safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(raw)
        : raw.toString('utf-8');
    }
  } catch { /* corrupt — regenerate */ }

  const secret = crypto.randomBytes(48).toString('hex');
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(secret)
    : Buffer.from(secret, 'utf-8');
  fs.writeFileSync(file, data, { mode: 0o600 });
  return secret;
}

// ── Splash ────────────────────────────────────────────────────────────────

const SPLASH_HTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:#111827}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;
font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.icon{width:72px;height:72px;background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);
border-radius:18px;display:flex;align-items:center;justify-content:center;font-size:36px;
margin-bottom:18px;box-shadow:0 8px 32px rgba(99,102,241,.35)}
h1{color:#f9fafb;font-size:17px;font-weight:600;margin-bottom:8px}
small{color:#94a3b8;font-size:12px;margin-bottom:20px}
.track{width:140px;height:2px;background:#1f2937;border-radius:1px;overflow:hidden}
.bar{height:100%;background:linear-gradient(90deg,#6366f1,#a78bfa);
animation:shimmer 1.4s ease-in-out infinite}
@keyframes shimmer{0%{width:0%;margin-left:0%}40%{width:60%;margin-left:20%}100%{width:0%;margin-left:100%}}
</style></head><body>
<div class="icon">📋</div><h1>MakeStudio Kanban</h1>
<small>iniciando…</small><div class="track"><div class="bar"></div></div>
</body></html>`;

function createSplash(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 400, height: 280, frame: false, center: true,
    resizable: false, movable: false, alwaysOnTop: true,
    backgroundColor: '#111827',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SPLASH_HTML)}`);
  return splash;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function getIconPath(): string {
  return path.join(__dirname, '..', '..', '..', 'assets', 'kanban', 'icon.png');
}

function handleDeepLink(url: string): void {
  try {
    const parsed = new URL(url);
    const appPath = parsed.pathname || '/kanban';
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('kanban:navigate', appPath);
  } catch {
    console.error('[kanban] invalid deep link:', url);
  }
}

function ensureActiveBoard(): library.BoardLibraryEntry {
  const active = library.getActive();
  if (active && fs.existsSync(active.filePath)) return active;
  const entries = library.list().filter((e) => fs.existsSync(e.filePath));
  if (entries.length > 0) return library.setActive(entries[0].id)!;
  const fresh = library.create('Meu Kanban');
  return library.setActive(fresh.id)!;
}

// ── Tray ──────────────────────────────────────────────────────────────────

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
    } else { void createWindow(); }
  };

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir MakeStudio Kanban', click: showWindow },
    { type: 'separator' },
    { label: 'Sair', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

// ── Main window ───────────────────────────────────────────────────────────

async function createWindow(): Promise<void> {
  const ws = loadWindowState();
  unmaximizedBounds = { ...ws };

  const splash = createSplash();
  const preloadPath = path.join(__dirname, 'preload.js');

  mainWindow = new BrowserWindow({
    x: ws.x, y: ws.y, width: ws.width, height: ws.height,
    minWidth: 1024, minHeight: 720,
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

  if (process.platform !== 'darwin') mainWindow.setMenuBarVisibility(false);

  let splashDismissed = false;
  const splashTimeout = setTimeout(() => dismissSplash(), 30_000);
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

  if (process.env.NODE_ENV === 'development')
    mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.webContents.on('render-process-gone', (_e: Electron.Event, details: Electron.RenderProcessGoneDetails) =>
    console.error('[kanban] renderer crashed:', details));
  mainWindow.webContents.on('did-fail-load', (_e: Electron.Event, code: number, desc: string, url: string) =>
    console.error(`[kanban] did-fail-load: ${code} ${desc} (${url})`));
  mainWindow.webContents.on('console-message', (_e: Electron.Event, level: number, message: string, line: number, sourceId: string) => {
    const tag = level === 3 ? 'ERROR' : level === 2 ? 'WARN' : 'LOG';
    console.log(`[kanban:${tag}] ${message}  (${sourceId}:${line})`);
  });

  const updateBounds = () => {
    if (mainWindow && !mainWindow.isMaximized() && !mainWindow.isMinimized())
      unmaximizedBounds = { ...mainWindow.getBounds(), maximized: false };
  };
  mainWindow.on('resize', updateBounds);
  mainWindow.on('move', updateBounds);

  mainWindow.on('close', (e: Electron.Event) => {
    saveWindowState({ ...unmaximizedBounds, maximized: mainWindow!.isMaximized() });
    if (!isQuitting && process.platform !== 'darwin') {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  // ── Boot embedded backend (zero infra) ─────────────────────────────────
  try {
    const jwtSecret = getOrCreateJwtSecret();
    const active = ensureActiveBoard();

    await backend.start({ databasePath: active.filePath, jwtSecret });
    await backend.waitForHealth();

    // Auto-login — backend issues a 1-year token, no login screen needed
    const tokenData = await backend.fetchDesktopToken();
    writeSession({
      token: tokenData.token,
      accessTokenExp: tokenData.tokenExpires,
      user: tokenData.user as AuthSession['user'],
    });
  } catch (err) {
    dismissSplash();
    console.error('[kanban] backend failed to start:', err);
    dialog.showErrorBox(
      'Falha ao iniciar o Kanban',
      `${(err as Error).message}\n\nVerifique se mks-kanban/backend foi buildado:\n  npm --prefix backend run build`,
    );
    app.quit();
    return;
  }

  const url = `${backend.getOrigin()}/`;
  console.log(`[kanban] loading ${url}`);
  mainWindow.loadURL(url).catch((err) =>
    console.error('[kanban] failed to load renderer:', err));
}

// ── IPC handlers ───────────────────────────────────────────────────────────

ipcMain.handle('kanban:auth:get', () => readSession());
ipcMain.handle('kanban:auth:set', (_e: Electron.IpcMainInvokeEvent, session: AuthSession) => writeSession(session));
ipcMain.handle('kanban:auth:clear', () => clearSession());

ipcMain.handle('kanban:notify', (_e: Electron.IpcMainInvokeEvent, { title, body }: { title: string; body: string }) => {
  if (!ElectronNotification.isSupported()) return;
  const n = new ElectronNotification({ title, body });
  n.on('click', () => {
    if (mainWindow) { if (!mainWindow.isVisible()) mainWindow.show(); mainWindow.focus(); }
  });
  n.show();
});

ipcMain.handle('kanban:badge', (_e: Electron.IpcMainInvokeEvent, count: number) => {
  if (process.platform === 'darwin' && app.dock)
    app.dock.setBadge(count > 0 ? String(count) : '');
});

ipcMain.handle('kanban:openExternal', (_e: Electron.IpcMainInvokeEvent, url: string) =>
  shell.openExternal(url));

ipcMain.handle('boardLibrary:list', () => library.list());
ipcMain.handle('boardLibrary:active', () => library.getActive());
ipcMain.handle('boardLibrary:create', (_e: Electron.IpcMainInvokeEvent, name: string) => library.create(name));
ipcMain.handle('boardLibrary:rename', (_e: Electron.IpcMainInvokeEvent, id: string, name: string) =>
  library.rename(id, name));
ipcMain.handle('boardLibrary:remove', (_e: Electron.IpcMainInvokeEvent, id: string, deleteFile?: boolean) =>
  library.remove(id, deleteFile));

ipcMain.handle('boardLibrary:open', async (_e: Electron.IpcMainInvokeEvent, id: string) => {
  const entry = library.setActive(id);
  if (!entry) throw new Error(`board ${id} not in library`);

  const jwtSecret = getOrCreateJwtSecret();
  await backend.switchTo(entry.filePath, jwtSecret);

  const tokenData = await backend.fetchDesktopToken();
  writeSession({
    token: tokenData.token,
    accessTokenExp: tokenData.tokenExpires,
    user: tokenData.user as AuthSession['user'],
  });

  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.loadURL(`${backend.getOrigin()}/kanban`).catch(() => {});

  return { entry };
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

// ── App lifecycle ──────────────────────────────────────────────────────────

app.setName('MakeStudio Kanban');

app.on('before-quit', async () => {
  isQuitting = true;
  await backend.stop();
});

app.whenReady().then(async () => {
  createTray();
  await createWindow();

  const ok = globalShortcut.register('CommandOrControl+Shift+K', () => {
    if (!mainWindow) void createWindow();
    else { if (!mainWindow.isVisible()) mainWindow.show(); mainWindow.focus(); }
  });
  if (!ok) console.warn('[kanban] CommandOrControl+Shift+K already in use');

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) void createWindow();
    else { mainWindow.show(); mainWindow.focus(); }
  });

  if (process.env.NODE_ENV !== 'development' && mainWindow)
    setupUpdater(mainWindow);
});

app.on('window-all-closed', () => { /* tray keeps app alive */ });
app.on('will-quit', () => { globalShortcut.unregisterAll(); });
