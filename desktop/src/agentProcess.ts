/**
 * Embedded MKS-CODE agent lifecycle.
 *
 * Spawns the MakeStudio CLI agent (makestudio repl) as a child Node process
 * using Electron's bundled runtime (ELECTRON_RUN_AS_NODE=1) — no system Node
 * required on the user's machine.
 *
 * Communication happens via IPC (child.send) and stdout lines. The renderer
 * talks to the agent through preload-bridged ipcMain handlers.
 *
 *   start()          — boot the agent process
 *   send(payload)    — send JSON to agent via IPC
 *   onMessage(cb)    — receive JSON from agent
 *   stop()           — graceful shutdown
 *   restart()        — stop + start
 */
import { app } from 'electron';
import { fork, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

let child: ChildProcess | null = null;

type MessageHandler = (msg: unknown) => void;
let messageHandler: MessageHandler | null = null;

function resolveAgentEntry(): string {
  const packaged = path.join(process.resourcesPath, 'app-agent', 'dist', 'index.js');
  if (fs.existsSync(packaged)) return packaged;
  const dev = path.join(__dirname, '..', '..', '..', 'gptapi', 'agent', 'dist', 'index.js');
  if (fs.existsSync(dev)) return dev;
  throw new Error(
    `MKS-CODE agent entry not found. Looked at:\n  ${packaged}\n  ${dev}\n` +
      'Run `npm run build` in the agent directory first.',
  );
}

export async function start(): Promise<void> {
  if (child) return; // already running

  const entry = resolveAgentEntry();

  child = fork(entry, [], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: process.env.NODE_ENV || 'production',
      MAKESTUDIO_PRODUCT: process.env.MAKESTUDIO_PRODUCT || 'kanban',
      // Prevent agent from trying to open browser or TTY
      CI: 'true',
      NO_COLOR: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  child.stdout?.on('data', (b: Buffer) => {
    const lines = b.toString('utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      // Agent outputs JSON lines prefixed with "MSG:" for structured messages
      if (line.startsWith('MSG:')) {
        try {
          const parsed = JSON.parse(line.slice(4));
          messageHandler?.(parsed);
        } catch {
          // ignore malformed
        }
      }
    }
    process.stdout.write(`[agent] ${b}`);
  });

  child.stderr?.on('data', (b: Buffer) => {
    process.stderr.write(`[agent!] ${b}`);
  });

  child.on('exit', (code, signal) => {
    // eslint-disable-next-line no-console
    console.log(`[agent] exited code=${code} signal=${signal}`);
    child = null;
  });

  child.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[agent] process error:', err);
  });
}

export function send(payload: unknown): void {
  if (!child) throw new Error('agent not started');
  child.send(JSON.stringify(payload));
}

export function onMessage(cb: MessageHandler): void {
  messageHandler = cb;
}

export async function stop(): Promise<void> {
  if (!child) return;
  const dying = child;
  child = null;
  messageHandler = null;
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

export async function restart(): Promise<void> {
  await stop();
  await start();
}

export function isRunning(): boolean {
  return child !== null;
}
