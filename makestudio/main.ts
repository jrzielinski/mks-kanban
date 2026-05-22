/**
 * MakeStudio Desktop — Electron shell entry-point.
 *
 * This file deliberately contains NO product logic. All Electron handlers,
 * IPC wiring, agent bootstrapping, branding, etc. live under
 * `desktop/products/<product>/`. The shell entry only:
 *
 *   1. Defense-in-depth installs the `diagnostics_channel.tracingChannel`
 *      polyfill (bootstrap.js does this earlier; we repeat in case the .js
 *      shim is bypassed by a custom packager).
 *   2. Registers `tsx/cjs` so `.ts` source from `agent/src/repl/*` can be
 *      `require()`d at runtime by the active product.
 *   3. Hands control to the active product's main module.
 *
 * Adding a new desktop product (e.g. AppBuilder, Kanban):
 *   - Create `desktop/products/<name>/main.ts` with the product's Electron
 *     setup (window, tray, IPC, branding, etc.).
 *   - Switch the require below to point at it (or wire a launcher flag).
 */

// ── 1. tracingChannel polyfill ──────────────────────────────────────────
// pino@10 calls `diagnostics_channel.tracingChannel(...)` at module load
// time, but Electron 28 ships Node 18.18.2 — that API only landed in
// 18.19. Patch the missing function BEFORE any agent code (which pulls in
// pino transitively via src/utils/log.ts → src/repl/debug-log.ts) is
// required. Inline because it must run before tsx/cjs is registered —
// importing a polyfill module would itself need tsx loaded first.
{
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dc = require('node:diagnostics_channel');
  if (typeof dc.tracingChannel !== 'function') {
    dc.tracingChannel = function tracingChannel(name: string): unknown {
      const start = dc.channel(`${name}:start`);
      const end = dc.channel(`${name}:end`);
      const asyncStart = dc.channel(`${name}:asyncStart`);
      const asyncEnd = dc.channel(`${name}:asyncEnd`);
      const error = dc.channel(`${name}:error`);
      return {
        name,
        start, end, asyncStart, asyncEnd, error,
        get hasSubscribers(): boolean {
          return start.hasSubscribers || end.hasSubscribers ||
                 asyncStart.hasSubscribers || asyncEnd.hasSubscribers ||
                 error.hasSubscribers;
        },
        traceSync<T>(fn: (...a: unknown[]) => T, _s: unknown, ctx: unknown, ...args: unknown[]): T {
          return (fn as (...a: unknown[]) => T).apply(ctx, args);
        },
        tracePromise<T>(fn: (...a: unknown[]) => Promise<T>, _s: unknown, ctx: unknown, ...args: unknown[]): Promise<T> {
          return (fn as (...a: unknown[]) => Promise<T>).apply(ctx, args);
        },
        traceCallback<T>(fn: (...a: unknown[]) => T, _p: number, _s: unknown, ctx: unknown, ...args: unknown[]): T {
          return (fn as (...a: unknown[]) => T).apply(ctx, args);
        },
        subscribe(): void { /* noop */ },
        unsubscribe(): boolean { return true; },
        bindStore<T>(_s: unknown, fn: (...a: unknown[]) => T): (...a: unknown[]) => T { return fn; },
      };
    };
  }
}

// ── 2. Register tsx/cjs ────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('tsx/cjs');

// ── 3. Dispatch to the active product ──────────────────────────────────
// MAKESTUDIO_PRODUCT picks the product folder under desktop/products/.
// Default: 'makestudio' (the full agent CLI desktop).
// Other supported values today: 'flowbuilder' (slim Flow product window).
const product = String(process.env.MAKESTUDIO_PRODUCT || 'makestudio').toLowerCase();
const KNOWN_PRODUCTS = new Set(['makestudio', 'flowbuilder', 'kanban']);
if (!KNOWN_PRODUCTS.has(product)) {
  // eslint-disable-next-line no-console
  console.error(
    `[shell] unknown MAKESTUDIO_PRODUCT="${product}". Known: ${Array.from(KNOWN_PRODUCTS).join(', ')}.`,
  );
  process.exit(1);
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
require(`./products/${product}/main`);
