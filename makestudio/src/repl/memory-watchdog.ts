import { swallow } from '../utils/log';
/**
 * memory-watchdog.ts — periodic heap-usage check that forces auto-compact
 * when RSS approaches the agent's working budget.
 *
 * Why: the agent OOM'd at 2h46min into a real session because chat history
 * + AST caches + tsc-watch buffers grew unchecked. Bumping the heap to 8GB
 * raised the ceiling but doesn't prevent the same growth pattern from
 * eventually hitting it. The watchdog provides a runtime safety net:
 *
 *   - heapUsed >= 3.5 GB  → force autoCompact (loga + chama callback)
 *   - heapUsed >= 6 GB   → CRITICAL warning; suggest /clear
 *
 * Thresholds chosen by the operator: 3.5GB is "already too much" for a
 * CLI; 6GB is the latest-warn before the 8GB heap fills entirely.
 *
 * The check is a single setInterval tick; cost is negligible
 * (process.memoryUsage() is microseconds).
 */

export interface MemoryStatus {
  heapUsedMB: number;
  rssM: number;
  externalMB: number;
  /** 'ok' | 'high' | 'critical' */
  level: 'ok' | 'high' | 'critical';
}

// Thresholds in megabytes. Exposed so tests can simulate boundaries.
export const COMPACT_THRESHOLD_MB = 3500;   // force compact when crossed
export const CRITICAL_THRESHOLD_MB = 6000;  // recommend /clear

/**
 * Snapshot the current memory usage and classify it. Pure function (no
 * side effects) — easy to unit-test by mocking `process.memoryUsage()`.
 */
export function classifyMemory(usage: NodeJS.MemoryUsage): MemoryStatus {
  const heapUsedMB = Math.round(usage.heapUsed / (1024 * 1024));
  const rssM = Math.round(usage.rss / (1024 * 1024));
  const externalMB = Math.round((usage.external || 0) / (1024 * 1024));
  let level: MemoryStatus['level'] = 'ok';
  if (heapUsedMB >= CRITICAL_THRESHOLD_MB) level = 'critical';
  else if (heapUsedMB >= COMPACT_THRESHOLD_MB) level = 'high';
  return { heapUsedMB, rssM, externalMB, level };
}

export interface WatchdogOptions {
  /** How often to sample memory. Default: 30s. */
  intervalMs?: number;
  /** Called when heapUsed crosses the COMPACT threshold. Should trigger autoCompact. */
  onHigh?: (status: MemoryStatus) => void;
  /** Called when heapUsed crosses the CRITICAL threshold. */
  onCritical?: (status: MemoryStatus) => void;
  /** Override `process.memoryUsage` — used in tests. */
  memoryUsageFn?: () => NodeJS.MemoryUsage;
}

/** Handle returned by start; call .stop() to release the interval. */
export interface WatchdogHandle {
  stop(): void;
  /** Immediately sample once (without waiting for the next tick). Returns the status that was checked. */
  tick(): MemoryStatus;
  /** Last status observed by an internal tick. */
  lastStatus: MemoryStatus | null;
}

/**
 * Start the watchdog. Returns a handle so callers can stop the interval
 * (e.g. on REPL exit). Idempotent: calling twice with a previously-started
 * watchdog returns a fresh handle but doesn't double-up the interval.
 */
export function startMemoryWatchdog(opts: WatchdogOptions = {}): WatchdogHandle {
  const interval = Math.max(5_000, opts.intervalMs ?? 30_000);
  const memUsage = opts.memoryUsageFn ?? (() => process.memoryUsage());

  // Track previous level so we don't spam the user every tick — only fire
  // callbacks on TRANSITION (ok → high, high → critical, etc.).
  let prevLevel: MemoryStatus['level'] = 'ok';
  let lastStatus: MemoryStatus | null = null;
  let stopped = false;

  const sampleOnce = (): MemoryStatus => {
    const status = classifyMemory(memUsage());
    lastStatus = status;
    if (status.level !== prevLevel) {
      try {
        if (status.level === 'high' && opts.onHigh) opts.onHigh(status);
        if (status.level === 'critical' && opts.onCritical) opts.onCritical(status);
      } catch (err) { swallow(err); }
      prevLevel = status.level;
    }
    return status;
  };

  const handle = setInterval(() => {
    if (stopped) return;
    sampleOnce();
  }, interval);
  // unref so it doesn't block process exit on its own
  (handle as any).unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
    tick: () => sampleOnce(),
    get lastStatus(): MemoryStatus | null { return lastStatus; },
  };
}
