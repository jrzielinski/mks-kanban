/**
 * Embedded backend lifecycle.
 *
 * Spawns the NestJS backend as a child Node process using Electron's
 * bundled runtime (ELECTRON_RUN_AS_NODE=1) — no system Node required on
 * the user's machine. The child reads `DATABASE_PATH` from env, so to
 * "switch board" we stop the process and start a new one pointing at a
 * different `.sqlite` file.
 *
 *   start({ databasePath })          — boot fresh
 *   waitForHealth()                  — poll /api/v1/health until ready
 *   switchTo(databasePath)           — stop + start with a new file
 *   stop()                           — graceful shutdown on app quit
 *   getOrigin()                      — http://127.0.0.1:<random-port>
 */
import { app } from 'electron';
import { fork, ChildProcess } from 'child_process';
import { createServer } from 'net';
import { randomBytes } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';

let child: ChildProcess | null = null;
let port: number | null = null;
let currentDbPath: string | null = null;
let __bootstrapToken: string | null = null;

const IDENTITY_ISSUER =
  process.env.IDENTITY_ISSUER ?? 'http://localhost:3030';
const IDENTITY_JWKS_URI =
  process.env.IDENTITY_JWKS_URI ?? `${IDENTITY_ISSUER}/.well-known/jwks.json`;

function resolveBackendEntry(): string {
  const packaged = path.join(process.resourcesPath, 'app-backend', 'dist', 'main.js');
  if (fs.existsSync(packaged)) return packaged;
  const dev = path.join(__dirname, '..', '..', 'backend', 'dist', 'main.js');
  if (fs.existsSync(dev)) return dev;
  throw new Error(
    `Embedded backend entry not found. Looked at:\n  ${packaged}\n  ${dev}\n` +
      'Run `npm --prefix backend run build` first.',
  );
}

function resolveFrontendDist(): string | null {
  const packaged = path.join(process.resourcesPath, 'app-frontend');
  if (fs.existsSync(path.join(packaged, 'index.html'))) return packaged;
  const dev = path.join(__dirname, '..', '..', 'frontend', 'dist');
  if (fs.existsSync(path.join(dev, 'index.html'))) return dev;
  return null;
}

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

export interface StartOptions {
  databasePath: string;
  port?: number;
  /** Persistent HS256 signing key (hex). Generated randomly if omitted. */
  jwtSecret?: string;
  /** Persistent AES-256 encryption key (hex). Generated randomly if omitted — unstable across restarts! */
  encryptionKey?: string;
}

export async function start({ databasePath, port: fixedPort, jwtSecret, encryptionKey }: StartOptions): Promise<void> {
  if (child) await stop();

  const entry = resolveBackendEntry();
  const backendRoot = path.resolve(path.dirname(entry), '..');
  const frontendDist = resolveFrontendDist();
  port = fixedPort ?? await pickFreePort();
  currentDbPath = databasePath;

  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  const localSecret = jwtSecret ?? randomBytes(32).toString('hex');
  const encKey = encryptionKey ?? randomBytes(32).toString('hex');
  __bootstrapToken = randomBytes(16).toString('hex');

  child = fork(entry, [], {
    cwd: backendRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: process.env.NODE_ENV || 'production',
      PORT: String(port),
      DB_DRIVER: 'sqlite',
      DATABASE_PATH: databasePath,
      LOCAL_JWT_SECRET: localSecret,
      LOCAL_BOOTSTRAP_TOKEN: __bootstrapToken,
      ENCRYPTION_KEY: encKey,
      IDENTITY_ISSUER,
      IDENTITY_JWKS_URI,
      IDENTITY_AUDIENCE: process.env.IDENTITY_AUDIENCE ?? 'mks-kanban',
      ...(frontendDist ? { FRONTEND_DIST: frontendDist } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  child.stdout?.on('data', (b) => process.stdout.write(`[backend] ${b}`));
  child.stderr?.on('data', (b) => process.stderr.write(`[backend!] ${b}`));
  child.on('exit', (code, signal) => {
    // eslint-disable-next-line no-console
    console.log(`[backend] exited code=${code} signal=${signal}`);
    child = null;
  });
}

export async function waitForHealth(timeoutMs = 15_000): Promise<void> {
  if (!port) throw new Error('backend not started');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetchHealth();
      return;
    } catch {
      await sleep(150);
    }
  }
  throw new Error(`backend health check timed out after ${timeoutMs}ms`);
}

function fetchHealth(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: port!, path: '/api/v1/health', timeout: 1500 },
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function stop(): Promise<void> {
  if (!child) return;
  const dying = child;
  child = null;
  port = null;
  currentDbPath = null;
  dying.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try { dying.kill('SIGKILL'); } catch { /* already gone */ }
      resolve();
    }, 3000);
    dying.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

export async function switchTo(databasePath: string): Promise<void> {
  const reusePort = port; // preserve port so renderer stays alive
  await start({ databasePath, port: reusePort ?? undefined });
  await waitForHealth();
}

export function getPort(): number | null {
  return port;
}

export function getOrigin(): string {
  if (!port) throw new Error('backend not started');
  return `http://127.0.0.1:${port}`;
}

export function getActivePath(): string | null {
  return currentDbPath;
}

export function getBootstrapToken(): string | null {
  return __bootstrapToken;
}

/**
 * Returns the live ChildProcess of the embedded backend, or null if
 * not started. Embedders (e.g. mks-code) use this to attach IPC
 * handlers — for example, to bridge `process.send` from the backend
 * back into the parent's agent-core (see mks-code/src/agent-bridge).
 */
export function getChild(): ChildProcess | null {
  return child;
}
// getAdminCredentials() (seeded-admin) intencionalmente NÃO portado: este
// branch migrou pra auth via JWKS/resource-server (sem seeded admin).
