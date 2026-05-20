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
import { AuthSession } from './authStore';
import { loadWindowState, saveWindowState, WindowState } from './windowState';
import { setupUpdater } from './updater';
import * as backend from './backendProcess';
import * as agent from './agentProcess';
import * as library from './boardLibrary';
import * as license from './licenseStore';
import { startOAuthFlow } from './oauthLoopback';

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

/** Authenticate locally using the bootstrap token.
 *  The embedded backend generates a one-time bootstrap token on each start.
 *  POST it to /auth/local-login, get a 24h JWT back, store in memory. */

async function ensureLocalSignedIn(bootstrapToken: string): Promise<void> {
  try {
    const origin = backend.getOrigin();
    const url = new URL('/api/v1/auth/email/login', origin);
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@zielinski.dev.br';
    const adminPassword = process.env.ADMIN_PASSWORD || 'password@123';
    const body = JSON.stringify({ email: adminEmail, password: adminPassword });

    const result = await new Promise<AuthSession | null>((resolve) => {
      const req = http.request(
        {
          method: 'POST',
          host: url.hostname,
          port: Number(url.port) || 80,
          path: url.pathname,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
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
                  accessTokenExp: json.expiresAt,
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
      req.write(body);
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
    await Promise.all([
      backend.start({ databasePath: active.filePath }),
      agent.start().catch((err) =>
        // eslint-disable-next-line no-console
        console.warn('[product:kanban] agent not available:', err.message),
      ),
    ]);
    await backend.waitForHealth();

    // Offline/local mode — auth against the embedded backend instead of remote identity
    const bootstrapToken = backend.getBootstrapToken();
    if (bootstrapToken) {
      await ensureLocalSignedIn(bootstrapToken);
    }
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

// ── Standalone Agent Window ─────────────────────────────────────────────
function createAgentWindow() {
  if (agentWindow && !agentWindow.isDestroyed()) {
    agentWindow.focus();
    return;
  }

  const template = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"/>
<title>MKS-CODE Terminal</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#c9d1d9;font-family:'Cascadia Code','Fira Code','JetBrains Mono',monospace;font-size:14px;line-height:1.5}
#t{overflow-y:auto;white-space:pre-wrap;word-break:break-word}
#f{position:fixed;bottom:0;left:0;right:0;display:flex;background:#161b22;border-top:1px solid #30363d}
#i{flex:1;background:transparent;border:none;color:#c9d1d9;font:inherit;padding:12px 16px;outline:none}
.prompt{color:#58a6ff}.output{color:#7ee787}.error{color:#f85149}.info{color:#8b949e}
</style></head>
<body><div id="t"><span class="info">MKS-CODE Terminal</span></div>
<div id="f"><input id="i" placeholder="> type a command…" autofocus/></div>
<script>
const{ipcRenderer}=require('electron'),t=document.getElementById('t'),i=document.getElementById('i');
ipcRenderer.on('agent:output',(_,d)=>{const e=document.createElement('div');
if(d.type==='error')e.className='error';else if(d.type==='prompt')e.className='prompt';else e.className='output';
e.textContent=d.text;t.appendChild(e);t.scrollTop=t.scrollHeight});
i.addEventListener('keydown',e=>{if(e.key==='Enter'&&i.value.trim()){const s='> '+i.value.trim();
const l=document.createElement('div');l.className='prompt';l.textContent=s;t.appendChild(l);
ipcRenderer.invoke('agent:send',i.value.trim());i.value=''}
if(e.key==='c'&&(e.ctrlKey||e.metaKey)){ipcRenderer.send('agent:cancel');
const d=document.createElement('div');d.className='info';d.textContent='^C';t.appendChild(d)}});
</script></body></html>`;

  agentWindow = new BrowserWindow({
    width: 900, height: 700, minWidth: 600, minHeight: 400,
    title: 'MKS-CODE Terminal', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: true,
    },
  });
  agentWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(template)}`);
  agentWindow.on('closed', () => { agentWindow = null; });
}

// ── App lifecycle ─────────────────────────────────────────────────────────
app.setName('MakeStudio Kanban');

app.on('before-quit', async () => {
  isQuitting = true;
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
