/**
 * remote/server.ts — Bridge between /remote slash-command and relay-client.
 *
 * This file wraps the Socket.IO relay client with the same public API
 * that slash-handlers/remote.ts calls (startRemoteServer, stopRemoteServer,
 * isRemoteRunning, getRemoteUrl, onTuiMessage, onStdoutData).
 *
 * Instead of running a local HTTP+WS server, it connects as role='agent'
 * to the backend relay at api.zielinski.dev.br. The browser page is served
 * by the backend at /relay/:sessionId?token=<token>.
 */

import { loadRemoteConfig } from './config';
import type { RemoteConfig } from './config';
import {
  connectRelay,
  disconnectRelay,
  isRelayConnected,
  getRelayUrl as getRelayClientUrl,
} from './relay-client';

// ── State ────────────────────────────────────────────────────────

let running = false;

// ── Public API (matches what slash-handlers/remote.ts expects) ───

export function isRemoteRunning(): boolean {
  return running;
}

export function getRemoteUrl(): string {
  const url = getRelayClientUrl();
  if (url) return url;

  // Fallback: show config URL without session
  const cfg = loadRemoteConfig();
  return `${cfg.relayUrl}/api/relay/<session>?token=${cfg.token.slice(0, 8)}...`;
}

let unsubBridge: (() => void) | null = null;

export function startRemoteServer(onError?: (err: Error) => void): Promise<boolean> {
  if (running) return Promise.resolve(false);

  const cfg = loadRemoteConfig();

  return connectRelay(cfg.relayUrl, cfg.token).then((ok) => {
    if (ok) {
      running = true;
    } else {
      onError?.(new Error(`Nao foi possivel conectar ao relay em ${cfg.relayUrl}`));
    }
    return ok;
  });
}

export function stopRemoteServer(): void {
  if (!running) return;

  disconnectRelay();
  running = false;
}

/**
 * Hook called by the TUI bridge when a new message is added.
 * Delegates to relay-client's onTuiMessage.
 */
export function onTuiMessage(role: string, text: string): void {
  // relay-client handles this via its internal bridge subscription
  // This is a no-op — the bridge hook in relay-client already captures messages
}

/**
 * Pipe raw stdout data to relay (for Ink frame content).
 * Delegates to relay-client's onStdoutData.
 */
export function onStdoutData(chunk: string): void {
  // relay-client handles stdout via its bridge subscription
  // This is a no-op for the same reason
}
