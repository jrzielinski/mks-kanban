import { swallow } from '../../utils/log';
/**
 * remote/relay-client.ts — Socket.IO client that connects to the backend relay.
 *
 * Instead of running a local HTTP+WS server, this connects as role='agent'
 * to the backend's /relay namespace. The browser connects as role='browser'
 * via the same relay. Messages flow through the backend.
 *
 * Usage:
 *   connectRelay()          — connect to relay, register bridge hooks
 *   disconnectRelay()       — disconnect, unregister hooks
 *   isRelayConnected()      — bool
 *   getRelayUrl(sessionId)  — full https:// URL to give the user
 */

import * as crypto from 'crypto';

// socket.io-client — present as devDependency, bundled by rollup
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { io: SocketIO } = require('socket.io-client') as {
  io: (uri: string, opts: any) => any;
};

type SocketType = any;

// ── State ────────────────────────────────────────────────────────

let socket: SocketType | null = null;
let connected = false;
let currentSessionId: string = '';
let currentRelayUrl: string = '';
let currentToken: string = '';
let unsubBridge: (() => void) | null = null;
let scrollbackBuffer: string[] = [];
const SCROLLBACK_MAX_LINES = 2000;
const SCROLLBACK_MAX_BYTES = 2 * 1024 * 1024; // 2MB cap
let scrollbackBytes = 0;
let connectTimer: ReturnType<typeof setTimeout> | null = null;

// Monkey-patch holders for stdout/stderr capture — restored after the
// real cause of the local-TUI duplication turned out to be `relay:resize`
// mutating process.stdout.columns/rows, not the patch itself.
let origStdoutWrite: ((chunk: any, encoding?: any, cb?: any) => boolean) | null = null;
let origStderrWrite: ((chunk: any, encoding?: any, cb?: any) => boolean) | null = null;

// ── Session ID generation ────────────────────────────────────

function generateSessionId(): string {
  // Short, URL-safe, unique per connection
  return crypto.randomBytes(12).toString('hex'); // 24 chars
}

// ── Helpers ─────────────────────────────────────────────────

function pushToScrollback(text: string): void {
  for (const line of text.split('\n')) {
    const bytes = Buffer.byteLength(line, 'utf8');
    scrollbackBuffer.push(line);
    scrollbackBytes += bytes;
    while (scrollbackBuffer.length > SCROLLBACK_MAX_LINES || scrollbackBytes > SCROLLBACK_MAX_BYTES) {
      const removed = scrollbackBuffer.shift();
      if (removed !== undefined) {
        scrollbackBytes -= Buffer.byteLength(removed, 'utf8');
      }
    }
  }
}

function emitAgentSize(): void {
  if (!connected || !socket) return;
  const cols = (process.stdout as any).columns || 120;
  const rows = (process.stdout as any).rows || 40;
  try {
    socket.emit('relay:agent-size', { cols, rows });
  } catch (err) { swallow(err); }
}

let agentResizeListener: (() => void) | null = null;

function installAgentResizeListener(): void {
  if (agentResizeListener) return;
  agentResizeListener = () => emitAgentSize();
  try { process.stdout.on('resize', agentResizeListener); } catch (err) { swallow(err); }
}

function removeAgentResizeListener(): void {
  if (!agentResizeListener) return;
  try { process.stdout.off('resize', agentResizeListener); } catch (err) { swallow(err); }
  agentResizeListener = null;
}

function injectToRepl(data: string): void {
  try {
    // process.stdin is a Readable. .write() doesn't push into the
    // read queue — on a TTY it actually goes the wrong direction
    // (terminal output). Emitting 'data' is what stdin consumers
    // (readline + Ink useInput) listen for.
    //
    // DO NOT normalize CR/LF: Ink's useInput detects Enter via
    // `input === '\\r'` (the CR), not '\\n'. xterm.onData sends \\r
    // when the user presses Enter, so passing the byte through
    // unchanged is exactly what Ink expects. An earlier version
    // converted \\r → \\n here, which made Ink treat Enter as a
    // literal newline character — InputBox added a line break to
    // the value instead of submitting the turn.
    (process.stdin as any).emit('data', Buffer.from(data, 'utf8'));
  } catch (err) { swallow(err); }
}

// ── Cached ANSI prefix/suffix per role ──────────────────────
const ROLE_PREFIX: Record<string, string> = {
  user: '\x1b[36m> \x1b[0m',
  error: '\x1b[31m',
  assistant: '\x1b[0m',
  info: '\x1b[90m',
  tool: '\x1b[90m',
};
const ROLE_SUFFIX: Record<string, string> = {
  error: '\x1b[0m',
};

// ── Bridge hook (message broadcast) ─────────────────────────

function sendToRelay(role: string, text: string): void {
  if (!connected || !socket) return;

  const prefix = ROLE_PREFIX[role] || '\x1b[90m';
  const suffix = ROLE_SUFFIX[role] || '';
  const output = prefix + text + suffix + '\r\n';

  pushToScrollback(output);
  socket.emit('relay:output', { text: output });
}

// ── Connect / Disconnect ────────────────────────────────────

export function connectRelay(relayUrl: string, token: string): Promise<boolean> {
  if (connected) return Promise.resolve(false);

  currentSessionId = generateSessionId();
  currentRelayUrl = relayUrl.replace(/\/$/, '');
  currentToken = token;

  return new Promise<boolean>((resolve) => {
    try {
      socket = SocketIO(`${currentRelayUrl}/relay`, {
        auth: { token, sessionId: currentSessionId, role: 'agent' },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 2000,
        timeout: 10000,
      });

      socket.on('connect', () => {
        connected = true;

        // Tell the relay server (and via it the browser, when it joins)
        // the EXACT dimensions of the agent's terminal. Ink renders with
        // process.stdout.columns/rows and emits absolute-cursor escapes,
        // so the browser xterm must match those dimensions or every
        // status-line / input-box position will land in the wrong place.
        emitAgentSize();
        installAgentResizeListener();

        // Subscribe to bridge for relay:output
        try {
          const { onMessage } = require('../tui/bridge');
          unsubBridge = onMessage((role: string, text: string) => {
            sendToRelay(role, text);
          });
        } catch (err) { swallow(err); }

        // Mirror raw stdout to the relay so the browser xterm reflects
        // the live TUI verbatim (chat history + InputBox + StatusLine).
        // The pass-through implementation here is safe — origStdoutWrite
        // is captured BEFORE we replace process.stdout.write, so the
        // wrapper just sees the chunk, forwards a copy, and lets the
        // real terminal write proceed unchanged.
        if (!origStdoutWrite) {
          origStdoutWrite = process.stdout.write.bind(process.stdout);
          process.stdout.write = ((chunk: any, encoding?: any, cb?: any) => {
            if (connected && socket && typeof chunk === 'string') {
              pushToScrollback(chunk);
              socket.emit('relay:output', { text: chunk });
            }
            return origStdoutWrite!(chunk, encoding, cb);
          }) as typeof process.stdout.write;
        }
        if (!origStderrWrite) {
          origStderrWrite = process.stderr.write.bind(process.stderr);
          process.stderr.write = ((chunk: any, encoding?: any, cb?: any) => {
            if (connected && socket && typeof chunk === 'string') {
              pushToScrollback(chunk);
              socket.emit('relay:output', { text: `\x1b[31m${chunk}\x1b[0m` });
            }
            return origStderrWrite!(chunk, encoding, cb);
          }) as typeof process.stderr.write;
        }

        // Clear connect timeout on successful connection
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }

        // Send scrollback on connect
        if (scrollbackBuffer.length > 0) {
          socket.emit('relay:scrollback', { lines: scrollbackBuffer });
        }

        resolve(true);
      });

      // Receive input from browser -> relay -> agent
      socket.on('relay:input', (data: { data: string }) => {
        if (data && typeof data.data === 'string') {
          injectToRepl(data.data);
        }
      });

      // Receive resize events from browser. INTENTIONALLY do NOT apply
      // them to process.stdout.columns/rows — Ink reads those values to
      // size every render. If the browser xterm is 200 cols and the
      // local terminal is 100, applying the browser's dimensions made
      // Ink generate 200-col content that wrapped on the local terminal,
      // and log-update's line-counting got out of sync — that's why
      // every keystroke produced a stacked, never-erased InputBox in
      // the local TUI after /remote enable. Browser xterm just renders
      // whatever the relay sends; mismatch is OK.
      socket.on('relay:resize', (_data: { cols: number; rows: number }) => {
        // no-op for now
      });

      // Browser joined notification — push agent dimensions immediately
      // so the browser can resize its xterm before any output arrives.
      socket.on('relay:browser-joined', () => {
        emitAgentSize();
        try {
          const { showToast } = require('../tui/bridge');
          showToast('Browser connected', { ttlMs: 3000, kind: 'info' });
        } catch (err) { swallow(err); }
      });

      // Browser left notification
      socket.on('relay:browser-left', () => {
        try {
          const { showToast } = require('../tui/bridge');
          showToast('Browser disconnected', { ttlMs: 3000, kind: 'info' });
        } catch (err) { swallow(err); }
      });

      socket.on('relay:connected', (data: { sessionId: string; role: string }) => {
        // Confirmed by server
      });

      socket.on('disconnect', (reason: string) => {
        connected = false;
      });

      socket.on('connect_error', (err: Error) => {
        connected = false;
        // Don't resolve here — reconnection will retry
      });

      socket.on('error', (err: Error) => {
        // Socket.IO error
      });

      // Timeout: if we don't connect within 10s, fail
      connectTimer = setTimeout(() => {
        connectTimer = null;
        if (!connected) {
          socket?.close();
          socket = null;
          resolve(false);
        }
      }, 10000);
    } catch (err: any) {
      socket = null;
      resolve(false);
    }
  });
}

export function disconnectRelay(): void {
  if (!socket) return;

  // Clear pending connect timeout
  if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }

  // Unsubscribe from bridge messages
  if (unsubBridge) {
    try { unsubBridge(); } catch (err) { swallow(err); }
    unsubBridge = null;
  }

  removeAgentResizeListener();
  try { socket.close(); } catch (err) { swallow(err); }
  socket = null;
  connected = false;
  currentSessionId = '';
  scrollbackBuffer = [];
  scrollbackBytes = 0;

  // Restore the original stdout/stderr writers so the local TUI
  // continues working after /remote disable.
  if (origStdoutWrite) {
    process.stdout.write = origStdoutWrite;
    origStdoutWrite = null;
  }
  if (origStderrWrite) {
    process.stderr.write = origStderrWrite;
    origStderrWrite = null;
  }
}

export function isRelayConnected(): boolean {
  return connected;
}

export function getRelaySessionId(): string {
  return currentSessionId;
}

export function getRelayUrl(): string {
  if (!currentRelayUrl || !currentSessionId) return '';
  return `${currentRelayUrl}/api/relay/${currentSessionId}?token=${currentToken}`;
}

// ── For backwards compat: onTuiMessage / onStdoutData ───────

export function onTuiMessage(role: string, text: string): void {
  sendToRelay(role, text);
}

export function onStdoutData(chunk: string): void {
  if (!connected || !socket) return;
  pushToScrollback(chunk);
  socket.emit('relay:output', { text: chunk });
}
