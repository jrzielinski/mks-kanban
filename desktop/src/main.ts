/**
 * Kanban product — Electron main process.
 *
 * Standalone embedded build:
 *   - Forks the NestJS backend as a child Node (ELECTRON_RUN_AS_NODE=1)
 *     pointed at the active board's `.sqlite` file inside userData.
 *   - Waits for `/api/v1/health`, then probes the cached session:
 *     if the access token is still valid it writes it back so the renderer
 *     gets it via kanban:auth:get; if expired it silently refreshes against
 *     mks-identity; if offline it leaves the session so the renderer can
 *     enter read-only mode with a banner.
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
  shell,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { spawn } from 'child_process';
import { AuthSession } from './authStore';
import { loadWindowState, saveWindowState, WindowState } from './windowState';
import { setupUpdater } from './updater';
import * as backend from './backendProcess';
import * as agent from './agentProcess';
import * as agentPty from './agentPty';
import * as library from './boardLibrary';
import * as license from './licenseStore';
import { loadOrCreateSecret } from './desktopSecret';
import { startOAuthFlow } from './oauthLoopback';
import { initLogger, getLogFilePath } from './logger';

// ── Persistent file logging ───────────────────────────────────────────────
// Tee stdout/stderr (main + forked backend/agent + renderer messages + crashes)
// to a file on disk so failures are recoverable even with no terminal attached.
app.setName('MakeStudio Kanban');
initLogger();
// eslint-disable-next-line no-console
console.log(`[product:kanban] log file: ${getLogFilePath()}`);

// ── Load .env from desktop root ──────────────────────────────────────────
try {
  const envPath = path.join(__dirname, '..', '.env');
  const envRaw = fs.readFileSync(envPath, 'utf-8');
  for (const line of envRaw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key) process.env[key] = val;
  }
} catch { /* .env file is optional */ }

process.env.MAKESTUDIO_PRODUCT = process.env.MAKESTUDIO_PRODUCT || 'kanban';

process.on('uncaughtException', (error) => {
  console.error('[product:kanban] UNCAUGHT EXCEPTION:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[product:kanban] UNHANDLED REJECTION:', reason);
});

const IDENTITY_URL = process.env.IDENTITY_ISSUER ?? 'http://localhost:3030';

// In-memory auth session — no file persistence
let currentAuthSession: AuthSession | null = null;

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
let agentWindow: BrowserWindow | null = null;
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

/** macOS menu-bar template glyph (monochrome, ~18px, auto light/dark). */
function getTrayIconPath(): string {
  return path.join(__dirname, '..', 'assets', 'kanban', 'trayTemplate.png');
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

// ── Auth helpers ──────────────────────────────────────────────────────────

/**
 * Obtain a long-lived desktop token from the embedded backend.
 * POST /api/v1/auth/desktop-token — no credentials required, only works
 * when LOCAL_JWT_SECRET is set (i.e. the backend is running in desktop mode).
 */
async function ensureLocalSignedIn(): Promise<void> {
  try {
    const origin = backend.getOrigin();
    const url = new URL('/api/v1/auth/desktop-token', origin);

    const result = await new Promise<AuthSession | null>((resolve) => {
      const req = http.request(
        {
          method: 'POST',
          host: url.hostname,
          port: Number(url.port) || 80,
          path: url.pathname,
          headers: { 'Content-Type': 'application/json', 'Content-Length': 0 },
          timeout: 5_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              const json = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
              if (json?.token) {
                resolve({
                  token: json.token,
                  refreshToken: '',
                  accessTokenExp: json.tokenExpires,
                  user: json.user,
                });
              } else {
                resolve(null);
              }
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    });

    if (result) currentAuthSession = result;
  } catch {
    // Leave stale session — renderer enters read-only mode
  }
}

// ── Backend bootstrap helpers ────────────────────────────────────────────

/** Ensure there is at least one board file in the library and one active. */
function ensureActiveBoard(): library.BoardLibraryEntry {
  const active = library.getActive();
  if (active && fs.existsSync(active.filePath)) return active;
  const entries = library.list().filter((e) => fs.existsSync(e.filePath));
  if (entries.length > 0) return library.setActive(entries[0].id)!;
  const fresh = library.create('Meu Kanban');
  return library.setActive(fresh.id)!;
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
  const iconPath = getTrayIconPath();
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();

  // macOS standard: a template image renders at the correct menu-bar size and
  // auto-inverts for light/dark. Electron picks up trayTemplate@2x.png on Retina.
  if (process.platform === 'darwin' && !icon.isEmpty()) {
    icon.setTemplateImage(true);
  }

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
    const secret = loadOrCreateSecret();
    // The MakeStudio Code agent is no longer pre-forked here — each terminal
    // view spawns its own TUI session on demand via agentPty (node-pty).
    await backend.start({
      databasePath: active.filePath,
      jwtSecret: secret.jwtSecret,
      encryptionKey: secret.encryptionKey,
    });
    await backend.waitForHealth();

    // Offline/local mode — auth against the embedded backend instead of remote identity
    await ensureLocalSignedIn();
  } catch (err) {
    clearTimeout(splashTimeout);
    dismissSplash();
    // eslint-disable-next-line no-console
    console.error('[product:kanban] backend failed to start:', err);
    dialog.showErrorBox(
      'Falha ao iniciar',
      `Não foi possível iniciar o backend embutido.\n\n${(err as Error).message}\n\n` +
        `Log completo em:\n${getLogFilePath()}`,
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

// Auth bridge — renderer uses these to read/write/clear the in-memory session
ipcMain.handle('kanban:auth:get', () => currentAuthSession);
ipcMain.handle('kanban:auth:set', (_e, session: AuthSession) => { currentAuthSession = session; });
ipcMain.handle('kanban:auth:clear', () => { currentAuthSession = null; });
// Expose .env credentials to the renderer (auto-fill login form)
ipcMain.handle('kanban:auth:get-env-creds', () => ({
  email: process.env.ADMIN_EMAIL || 'admin@zielinski.dev.br',
  password: process.env.ADMIN_PASSWORD || 'password@123',
}));

// Local login — renderer delegates credential POST to local backend (correct port)
ipcMain.handle('kanban:auth:login', async (_e, credentials: { email: string; password: string }) => {
  const origin = backend.getOrigin();
  const response = await fetch(`${origin}/api/v1/auth/email/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Login failed: ${response.status} ${errBody}`);
  }
  const session = (await response.json()) as AuthSession;
  currentAuthSession = session;
  return session;
});

// OAuth loopback — renderer can trigger the full OAuth flow from main process
ipcMain.handle('kanban:auth:oauth', async () => {
  try {
    const result = await startOAuthFlow(IDENTITY_URL, 'mks-kanban', (url) =>
      shell.openExternal(url),
    );
    const session: AuthSession = {
      token: result.accessToken,
      refreshToken: result.refreshToken,
      accessTokenExp: result.tokenExpires,
      user: result.user,
    };
    currentAuthSession = session;
    return session;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[product:kanban] OAuth flow failed:', err);
    return null;
  }
});

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

// ── Agent IPC handlers ──────────────────────────────────────────────────
ipcMain.handle('agent:send', (_e, input: string) => {
  return new Promise<string>((resolve, reject) => {
    const id = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const t = setTimeout(() => reject(new Error('agent response timeout')), 60_000);
    agent.onMessage((msg) => {
      if ((msg as { id: string }).id === id) {
        clearTimeout(t);
        resolve((msg as { text: string }).text);
      }
    });
    try {
      agent.send({ type: 'prompt', id, text: input });
    } catch (err) {
      clearTimeout(t);
      reject(err);
    }
  });
});
ipcMain.handle('agent:restart', () => agent.restart());
ipcMain.handle('agent:isRunning', () => agent.isRunning());
ipcMain.handle('agent:toggle-standalone', () => {
  if (agentWindow && !agentWindow.isDestroyed()) {
    agentWindow.close();
    return false;
  }
  createAgentWindow();
  return true;
});
// Open (or focus) the standalone MakeStudio Code window.
ipcMain.handle('agent:open-window', () => {
  createAgentWindow();
  return true;
});

/**
 * Launch the full MakeStudio Code Electron app (gptapi/agent/desktop) as a
 * completely separate process. Uses the gptapi's own Electron binary so the
 * two apps stay independent — closing one doesn't affect the other.
 */
ipcMain.handle('agent:open-makestudio', () => {
  // Resolve gptapi desktop entry and its Electron binary
  const home = app.getPath('home');
  const candidates = {
    entry: [
      path.join(home, 'gptapi', 'agent', 'desktop', 'dist', 'main.js'),
      path.join(__dirname, '..', '..', '..', 'gptapi', 'agent', 'desktop', 'dist', 'main.js'),
    ],
    electron: [
      path.join(home, 'gptapi', 'agent', 'desktop', 'node_modules', 'electron', 'dist', 'electron'),
      // fallback: use our own Electron binary (same version)
      path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron'),
    ],
  };

  const entry    = candidates.entry.find(fs.existsSync);
  const electron = candidates.electron.find(fs.existsSync);

  if (!entry || !electron) {
    dialog.showErrorBox(
      'MakeStudio Code',
      `App não encontrado.\n\nVerifique se o gptapi está buildado:\n  cd ~/gptapi/agent/desktop && npm run build`,
    );
    return false;
  }

  const child = spawn(electron, ['--no-sandbox', entry], {
    detached: true,
    stdio: 'ignore',
    cwd: path.dirname(entry),
  });
  child.unref(); // não bloqueia o kanban quando o MakeStudio for fechado
  // eslint-disable-next-line no-console
  console.log(`[product:kanban] launched MakeStudio Code (pid=${child.pid})`);
  return true;
});

// ── MakeStudio Code TUI over a pseudo-terminal (node-pty) ────────────────
ipcMain.handle('agent:pty:start', (e, opts: { cols?: number; rows?: number } = {}) =>
  agentPty.start(e.sender, opts),
);
ipcMain.on('agent:pty:write', (_e, id: string, data: string) => agentPty.write(id, data));
ipcMain.on('agent:pty:resize', (_e, id: string, cols: number, rows: number) =>
  agentPty.resize(id, cols, rows),
);
ipcMain.on('agent:pty:kill', (_e, id: string) => agentPty.kill(id));

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

/** Switch active board: restarts the embedded backend pointing at the new file.
 *  Auth tokens are issued by mks-identity and remain valid across board switches. */
ipcMain.handle('boardLibrary:open', async (_e, id: string) => {
  const entry = library.setActive(id);
  if (!entry) throw new Error(`board ${id} not in library`);
  await backend.switchTo(entry.filePath);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.reload();
  }
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

// ── License IPC handlers ────────────────────────────────────────────────
ipcMain.handle('license:getState', () => license.getLicenseState());
ipcMain.handle('license:install', (_e, jwt: string) => license.installLicense(jwt));
ipcMain.handle('license:clear', () => { license.clearLicense(); return true; });
ipcMain.handle('license:getMachineId', () => license.getMachineId());
ipcMain.handle('license:refresh', () => license.refreshLicenseState());

// ── Standalone Agent Window (MakeStudio Code) ───────────────────────────
// Loads the same React app at ?view=agent — which renders a full-window agent
// terminal — using the same secure preload bridge as the main window, so
// window.kanbanDesktop.agent works exactly as it does in the embedded panel.
function createAgentWindow(): void {
  if (agentWindow && !agentWindow.isDestroyed()) {
    if (!agentWindow.isVisible()) agentWindow.show();
    agentWindow.focus();
    return;
  }

  let origin: string;
  try {
    origin = backend.getOrigin();
  } catch {
    // Backend not up yet — nothing to load. Surface it instead of crashing.
    dialog.showErrorBox('MakeStudio Code', 'O backend ainda não está pronto.');
    return;
  }

  agentWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 400,
    title: 'MakeStudio Code',
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  agentWindow.loadURL(`${origin}/?view=agent`).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[product:kanban] failed to load agent window', err);
  });
  agentWindow.on('closed', () => {
    agentWindow = null;
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────

app.on('before-quit', async () => {
  isQuitting = true;
  agentPty.killAll();
  await Promise.all([backend.stop(), agent.stop()]);
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

  const agentShortcut = globalShortcut.register('CommandOrControl+Shift+T', () => {
    createAgentWindow();
  });
  if (!agentShortcut) {
    // eslint-disable-next-line no-console
    console.warn('[product:kanban] CommandOrControl+Shift+T already in use by another app');
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
}).catch((error) => {
  console.error('[product:kanban] Failed to initialize app:', error);
  app.quit();
});

app.on('window-all-closed', () => {
  // tray keeps the app alive
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
