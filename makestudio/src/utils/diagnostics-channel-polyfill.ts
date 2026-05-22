/**
 * diagnostics-channel-polyfill.ts — fills in `tracingChannel()` for the
 * Node bundled with Electron 28 (18.18.2), which predates that API.
 *
 * Why this exists:
 *   pino@10.x calls `diagnostics_channel.tracingChannel('pino_asJson')`
 *   at LOAD TIME (lib/tools.js line 32). When the agent CLI is hosted
 *   inside Electron 28, that throws "diagChan.tracingChannel is not a
 *   function" and every log call dies. The native Node 18.19+ shipped
 *   with Electron 30+ has it, but bumping Electron is not free here —
 *   the rest of the desktop is pinned to 28.x.
 *
 * Usage:
 *   import './diagnostics-channel-polyfill'; // BEFORE any pino import
 *
 * The polyfill is a no-op tracer: traceSync / tracePromise / traceCallback
 * just invoke the function with no instrumentation, hasSubscribers is
 * false, and start/end/error are real channels (so subscribe() shape stays
 * intact for any code that probes the API). That matches the surface pino
 * actually exercises (`hasSubscribers` short-circuit + `traceSync`) without
 * lying about active tracing.
 */

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
      start,
      end,
      asyncStart,
      asyncEnd,
      error,
      get hasSubscribers(): boolean {
        return (
          start.hasSubscribers ||
          end.hasSubscribers ||
          asyncStart.hasSubscribers ||
          asyncEnd.hasSubscribers ||
          error.hasSubscribers
        );
      },
      traceSync<T>(fn: (...a: unknown[]) => T, _store: unknown, ctx: unknown, ...args: unknown[]): T {
        return (fn as (...a: unknown[]) => T).apply(ctx, args);
      },
      tracePromise<T>(fn: (...a: unknown[]) => Promise<T>, _store: unknown, ctx: unknown, ...args: unknown[]): Promise<T> {
        return (fn as (...a: unknown[]) => Promise<T>).apply(ctx, args);
      },
      traceCallback<T>(fn: (...a: unknown[]) => T, _position: number, _store: unknown, ctx: unknown, ...args: unknown[]): T {
        return (fn as (...a: unknown[]) => T).apply(ctx, args);
      },
      subscribe(_handlers: Record<string, (...a: unknown[]) => void>): void { /* noop */ },
      unsubscribe(_handlers: Record<string, (...a: unknown[]) => void>): boolean { return true; },
      bindStore<T>(_store: unknown, fn: (...a: unknown[]) => T): (...a: unknown[]) => T { return fn; },
    };
  };
}

export {};
