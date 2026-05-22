import { swallow } from './log';
/**
 * warning-handler.ts
 *
 * Bounded `process.on('warning')` handler. Ported from Claude Code's
 * src/utils/warningHandler.ts — simplified for MakeStudio (no Statsig
 * analytics; we log to events.jsonl when available).
 *
 * Two goals:
 *
 *  1. Suppress noisy internal warnings (MaxListenersExceededWarning on
 *     AbortSignal/EventTarget) that Node.js emits when our subagents spawn
 *     many child controllers. These reach stderr and scroll Ink's output,
 *     which users mistake for errors.
 *
 *  2. Prevent unbounded memory growth from the warning-count Map. A broken
 *     dependency can emit 1000s of unique warning messages — the Map has
 *     MAX_WARNING_KEYS=1000 ceiling. Once capped, new keys drop into an
 *     "unknown" bucket (still counted, just not individually keyed).
 */

export const MAX_WARNING_KEYS = 1000;

const warningCounts = new Map<string, number>();
let handler: ((w: Error) => void) | null = null;

const INTERNAL_WARNINGS: readonly RegExp[] = [
  /MaxListenersExceededWarning.*AbortSignal/,
  /MaxListenersExceededWarning.*EventTarget/,
  /ExperimentalWarning/,
];

function isInternalWarning(w: Error): boolean {
  const s = `${w.name}: ${w.message}`;
  return INTERNAL_WARNINGS.some((rx) => rx.test(s));
}

function recordCount(key: string): number {
  const prev = warningCounts.get(key) || 0;
  if (warningCounts.has(key) || warningCounts.size < MAX_WARNING_KEYS) {
    warningCounts.set(key, prev + 1);
  }
  return prev + 1;
}

/**
 * Install once per process. Safe to call multiple times — idempotent.
 * Pass `{ suppressDefault: true }` to remove Node's default handler that
 * prints warnings to stderr. Defaults to true in production, false when
 * DEBUG env var is set.
 */
export function initializeWarningHandler(opts: { suppressDefault?: boolean } = {}): void {
  if (handler && process.listeners('warning').includes(handler as any)) return;

  const isDebug = !!process.env.DEBUG && process.env.DEBUG.includes('makestudio');
  const suppressDefault = opts.suppressDefault ?? !isDebug;
  if (suppressDefault) {
    process.removeAllListeners('warning');
  }

  handler = (w: Error) => {
    try {
      const key = `${w.name}: ${String(w.message).slice(0, 80)}`;
      const count = recordCount(key);
      const internal = isInternalWarning(w);
      try {
        require('./events').recordEvent('node_warning', {
          name: w.name,
          internal,
          count,
          message: w.message.slice(0, 200),
        });
      } catch (err) { swallow(err); }
      if (isDebug && !internal) {
        try { process.stderr.write(`[warning] ${w.toString()}\n`); } catch (err) { swallow(err); }
      }
    } catch (err) { swallow(err); }
  };
  process.on('warning', handler);

  // Lift AbortSignal listener cap so the normal subagent fan-out doesn't
  // even trigger the warning in the first place. Node default is 10; we
  // go to 50 matching Claude Code's setMaxListeners pattern.
  try {
    const { setMaxListeners } = require('events');
    setMaxListeners?.(50);
  } catch (err) { swallow(err); }
}

/** Test-only reset so fixtures don't leak state. */
export function __resetWarningHandlerForTests(): void {
  if (handler) {
    try { process.removeListener('warning', handler); } catch (err) { swallow(err); }
  }
  handler = null;
  warningCounts.clear();
}

/** Observability: used by /stats to show what noisy warnings fired. */
export function getWarningCounts(): Record<string, number> {
  return Object.fromEntries(warningCounts);
}
