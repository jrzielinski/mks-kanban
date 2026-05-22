/**
 * Embedded kanban backend lifecycle.
 *
 * Spawns the mks-kanban NestJS backend as a child Node process using
 * Electron's bundled runtime (ELECTRON_RUN_AS_NODE=1) — no system Node
 * or external database required on the user's machine.
 *
 * The backend uses better-sqlite3 in desktop mode (DB_DRIVER=sqlite).
 * Each board is a standalone `.sqlite` file; switching boards just
 * restarts the child process pointing at a different file.
 *
 *   start({ databasePath, jwtSecret })  — boot fresh
 *   waitForHealth()                      — poll /api/v1/health until ready
 *   fetchDesktopToken()                  — auto-login (no identity server)
 *   switchTo(databasePath, jwtSecret)    — stop + start with a new file
 *   stop()                               — graceful shutdown on app quit
 *   getOrigin()                          — http://127.0.0.1:<random-port>
 */
import { app } from 'electron';
import { fork, ChildProcess } from 'child_process';
import { createServer } from 'net';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';

let child: ChildProcess | null = null;
let port: number | null = null;
let currentDbPath: string | null = null;

// ── Path resolution ────────────────────────────────────────────────────────

/**
 * Find the mks-kanban NestJS backend entry point.
 *
 * Search order:
 *  1. KANBAN_BACKEND_ENTRY env var (dev convenience override)
 *  2. Packaged: <resourcesPath>/app-backend/dist/main.js
 *  3. Dev sibling: walk up from __dirname to find mks-kanban/backend/dist/main.js
 */
function resolveBackendEntry(): string {
  // 1. Explicit override
  if (process.env.KANBAN_BACKEND_ENTRY) {
    if (fs.existsSync(process.env.KANBAN_BACKEND_ENTRY)) {
      return process.env.KANBAN_BACKEND_ENTRY;
    }
  }

  // 2. Packaged build
  const packaged = path.join(process.resourcesPath, 'app-backend', 'dist', 'main.js');
  if (fs.existsSync(packaged)) return packaged;

  // 3. Dev: gptapi/agent/desktop/dist/products/kanban/ → walk up to find mks-kanban sibling
  // __dirname is typically: <gptapi>/agent/desktop/dist/products/kanban
  // mks-kanban is at:       <gptapi>/../mks-kanban  OR  <workspace>/mks-kanban
  const candidates = [
    // gptapi and mks-kanban are siblings under the same workspace
    path.join(__dirname, '..', '..', '..', '..', '..', '..', 'mks-kanban', 'backend', 'dist', 'main.js'),
    // ts-node / tsx from source: __dirname = agent/desktop/products/kanban
    path.join(__dirname, '..', '..', '..', '..', '..', 'mks-kanban', 'backend', 'dist', 'main.js'),
    // fallback: home dir
    path.join(app.getPath('home'), 'mks-kanban', 'backend', 'dist', 'main.js'),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  throw new Error(
    `mks-kanban backend entry not found.\n` +
    `Set KANBAN_BACKEND_ENTRY=<path> or run:\n` +
    `  cd mks-kanban && npm --prefix backend run build`,
  );
}

/**
 * Find the mks-kanban frontend dist (served as static by the backend).
 * Returns null in dev (separate Vite server) or if not yet built.
 */
function resolveFrontendDist(): string | null {
  if (process.env.KANBAN_FRONTEND_DIST) {
    if (fs.existsSync(path.join(process.env.KANBAN_FRONTEND_DIST, 'index.html'))) {
      return process.env.KANBAN_FRONTEND_DIST;
    }
  }

  const candidates = [
    path.join(process.resourcesPath, 'app-frontend'),
    path.join(__dirname, '..', '..', '..', '..', '..', '..', 'mks-kanban', 'frontend', 'dist'),
    path.join(__dirname, '..', '..', '..', '..', '..', 'mks-kanban', 'frontend', 'dist'),
    path.join(app.getPath('home'), 'mks-kanban', 'frontend', 'dist'),
  ];

  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  return null;
}

// ── Port picking ───────────────────────────────────────────────────────────

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('bad address'));
        return;
      }
      const p = addr.port;
      srv.close(() => resolve(p));
    });
  });
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

export interface StartOptions {
  databasePath: string;
  /** HS256 secret (hex string) — generated once per userData and stored encrypted. */
  jwtSecret: string;
}

export async function start({ databasePath, jwtSecret }: StartOptions): Promise<void> {
  if (child) await stop();

  const entry = resolveBackendEntry();
  const frontendDist = resolveFrontendDist();
  port = await pickFreePort();
  currentDbPath = databasePath;

  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  child = fork(entry, [], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: process.env.NODE_ENV || 'production',
      PORT: String(port),
      // SQLite mode — no PostgreSQL, no Redis, no identity server
      DB_DRIVER: 'sqlite',
      DATABASE_PATH: databasePath,
      // LOCAL_JWT_SECRET: hex-encoded HS256 key used by both jwt.strategy
      // (verification) and the desktop-token endpoint (signing).
      LOCAL_JWT_SECRET: jwtSecret,
      ...(frontendDist ? { FRONTEND_DIST: frontendDist } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  child.stdout?.on('data', (b: Buffer) => process.stdout.write(`[kanban-backend] ${b}`));
  child.stderr?.on('data', (b: Buffer) => process.stderr.write(`[kanban-backend!] ${b}`));
  child.on('exit', (code, signal) => {
    console.log(`[kanban-backend] exited code=${code} signal=${signal}`);
    child = null;
  });
}

export async function waitForHealth(timeoutMs = 20_000): Promise<void> {
  if (!port) throw new Error('backend not started');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetchHealth();
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`kanban backend health check timed out after ${timeoutMs}ms`);
}

function fetchHealth(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: port!, path: '/api/v1/health', timeout: 2000 },
      (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else reject(new Error(`status ${res.statusCode}`));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

/**
 * Call the backend's desktop-token endpoint to get a long-lived JWT.
 * No credentials required — the backend only exposes this in SQLite mode.
 */
export function fetchDesktopToken(): Promise<{
  token: string;
  tokenExpires: number;
  user: Record<string, unknown>;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: port!,
        path: '/api/v1/auth/desktop-token',
        headers: { 'Content-Type': 'application/json', 'Content-Length': 0 },
        timeout: 5000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            if (json?.token) resolve(json);
            else reject(new Error('desktop-token: invalid response'));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('desktop-token timeout')); });
    req.end();
  });
}

export async function stop(): Promise<void> {
  if (!child) return;
  const dying = child;
  child = null;
  port = null;
  currentDbPath = null;
  dying.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try { dying.kill('SIGKILL'); } catch { /* gone */ }
      resolve();
    }, 3000);
    dying.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

export async function switchTo(databasePath: string, jwtSecret: string): Promise<void> {
  await start({ databasePath, jwtSecret });
  await waitForHealth();
}


export function getOrigin(): string {
  if (!port) throw new Error('kanban backend not started');
  return `http://127.0.0.1:${port}`;
}

export function getActivePath(): string | null {
  return currentDbPath;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
