import { swallow } from '../../utils/log';
/**
 * Helper to push events from main to all renderer windows.
 *
 * The Electron main process wires this up at boot by calling
 * `setBroadcaster()` with an implementation that iterates
 * `BrowserWindow.getAllWindows()` and calls `webContents.send(channel, payload)`.
 *
 * This file deliberately does NOT import `electron` — it keeps the agent
 * bundle decoupled from Electron so the CLI continues working.
 */

export type Broadcaster = (channel: string, payload?: unknown) => void;

let broadcaster: Broadcaster | null = null;

export function setBroadcaster(fn: Broadcaster | null): void {
  broadcaster = fn;
}

export function broadcast(channel: string, payload?: unknown): void {
  if (!broadcaster) return;
  try {
    broadcaster(channel, payload);
  } catch (err) { swallow(err); }
}

export function hasBroadcaster(): boolean {
  return broadcaster !== null;
}
