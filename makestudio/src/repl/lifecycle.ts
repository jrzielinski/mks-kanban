let _destroy: (() => void | Promise<void>) | null = null;
let _recreate: (() => void) | null = null;

export function registerLifecycle(destroy: () => void | Promise<void>, recreate: () => void): void {
  _destroy = destroy;
  _recreate = recreate;
}

/** Tear down the active REPL/TUI. Returns a Promise so callers can await
 *  full cleanup — Ink's unmount is async (useEffect cleanup runs on next
 *  tick), and withDetachedRepl needs raw-mode reset to be DONE before
 *  spawning a sub-readline. */
export async function destroyRepl(): Promise<void> {
  if (!_destroy) return;
  const r = _destroy();
  if (r && typeof (r as any).then === 'function') await r;
}

export function recreateRepl(): void {
  if (_recreate) _recreate();
}
