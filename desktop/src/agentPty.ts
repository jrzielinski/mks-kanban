/**
 * MakeStudio Code TUI inside a pseudo-terminal.
 *
 * The agent only launches its rich TUI when stdin/stdout are real TTYs
 * (`useTui = !MAKESTUDIO_PLAIN && stdin.isTTY && stdout.isTTY`). A normal
 * child_process.fork gives pipes, not TTYs — so it falls back to the plain
 * REPL. Here we spawn it through node-pty, which gives it a real TTY, so the
 * genuine TUI runs and its ANSI output is streamed to an xterm.js terminal in
 * the renderer.
 *
 * One pty session per terminal view (window or panel), keyed by id:
 *   start(wc, opts)   — spawn a session bound to a renderer; returns its id
 *   write/resize/kill — drive a session
 *   killAll()         — on app quit
 */
import { WebContents } from 'electron';
import * as pty from 'node-pty';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { randomBytes } from 'crypto';

interface Session {
  proc: pty.IPty;
  wc: WebContents;
}

const sessions = new Map<string, Session>();

/** Same resolution as agentProcess: packaged app-agent, else dev gptapi/agent. */
function resolveAgentEntry(): string {
  const packaged = path.join(process.resourcesPath, 'app-agent', 'dist', 'index.js');
  if (fs.existsSync(packaged)) return packaged;
  const dev = path.join(__dirname, '..', '..', '..', 'gptapi', 'agent', 'dist', 'index.js');
  if (fs.existsSync(dev)) return dev;
  throw new Error(
    `MKS-CODE agent entry not found. Looked at:\n  ${packaged}\n  ${dev}`,
  );
}

export function start(wc: WebContents, opts: { cols?: number; rows?: number }): string {
  const id = randomBytes(8).toString('hex');
  const entry = resolveAgentEntry();

  // Run the agent via Electron's own Node (ELECTRON_RUN_AS_NODE) so no system
  // Node is required. Critically, do NOT set CI / NO_COLOR / MAKESTUDIO_PLAIN —
  // those would suppress the TUI.
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env.CI;
  delete env.NO_COLOR;
  delete env.MAKESTUDIO_PLAIN;
  env.ELECTRON_RUN_AS_NODE = '1';
  env.MAKESTUDIO_PRODUCT = process.env.MAKESTUDIO_PRODUCT || 'kanban';
  env.TERM = 'xterm-256color';
  env.FORCE_COLOR = '1';

  const proc = pty.spawn(process.execPath, [entry], {
    name: 'xterm-256color',
    cols: opts.cols && opts.cols > 0 ? opts.cols : 80,
    rows: opts.rows && opts.rows > 0 ? opts.rows : 24,
    cwd: os.homedir(),
    env,
  });

  const sendToRenderer = (channel: string, payload: unknown) => {
    // The frame can be torn down between checks during shutdown/navigation.
    try {
      if (!wc.isDestroyed()) wc.send(channel, payload);
    } catch {
      /* renderer frame already gone */
    }
  };

  proc.onData((data) => sendToRenderer('agent:pty:data', { id, data }));
  proc.onExit(({ exitCode }) => {
    // eslint-disable-next-line no-console
    console.log(`[pty] session ${id} exited code=${exitCode}`);
    sendToRenderer('agent:pty:exit', { id, exitCode });
    sessions.delete(id);
  });

  sessions.set(id, { proc, wc });
  // eslint-disable-next-line no-console
  console.log(`[pty] session ${id} started (pid=${proc.pid}, ${proc.cols}x${proc.rows}) → ${entry}`);
  return id;
}

export function write(id: string, data: string): void {
  sessions.get(id)?.proc.write(data);
}

export function resize(id: string, cols: number, rows: number): void {
  if (cols > 0 && rows > 0) {
    try {
      sessions.get(id)?.proc.resize(cols, rows);
    } catch {
      /* session may have exited mid-resize */
    }
  }
}

export function kill(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  try {
    s.proc.kill();
  } catch {
    /* already gone */
  }
  sessions.delete(id);
}

export function killAll(): void {
  for (const s of sessions.values()) {
    try {
      s.proc.kill();
    } catch {
      /* already gone */
    }
  }
  sessions.clear();
}
