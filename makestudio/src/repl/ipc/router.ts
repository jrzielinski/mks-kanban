/**
 * IPC router — registers handlers on the Electron main side.
 *
 * Called from agent/desktop/main.ts at boot (only when running in
 * Electron). Each domain module registers its `handle`/`on` pairs here
 * so the main entrypoint stays short.
 *
 * Like broadcast.ts, this file avoids importing `electron` directly so
 * the agent bundle stays platform-agnostic.
 */

export interface IpcRouter {
  handle(channel: string, handler: (payload: unknown) => unknown | Promise<unknown>): void;
  on(channel: string, handler: (payload: unknown) => void): void;
}

let router: IpcRouter | null = null;

export function setIpcRouter(r: IpcRouter | null): void {
  router = r;
}

export function getIpcRouter(): IpcRouter | null {
  return router;
}

/**
 * Convenience: register a request/response handler. Safe no-op when no
 * router is installed (CLI mode).
 */
export function registerHandler(
  channel: string,
  handler: (payload: unknown) => unknown | Promise<unknown>,
): void {
  router?.handle(channel, handler);
}

export function registerListener(
  channel: string,
  handler: (payload: unknown) => void,
): void {
  router?.on(channel, handler);
}
