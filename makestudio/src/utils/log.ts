/**
 * log.ts — structured logger.
 *
 * Plain stderr JSON-line logger with a pino-compatible surface so existing
 * callers (`logger.warn({ err }, 'msg')`, `logger.child({ ns })`) keep
 * working unchanged. We don't actually use pino because pino@10 calls
 * `diagnostics_channel.tracingChannel()` at load time, which is a Node
 * 18.19+ API and is missing from the Node 18.18.2 bundled in Electron 28.
 * Polyfill attempts proved racy across the agent → Electron load order;
 * dropping the dep entirely is the only way to guarantee correctness.
 *
 * Output: one JSON object per line on stderr, e.g.:
 *   {"time":"2026-05-07T23:55:01.123Z","level":"warn","name":"makestudio",
 *    "ns":"session","msg":"close debug log failed","err":{...}}
 *
 * Level resolution (highest priority first):
 *   1. LOG_LEVEL env (trace/debug/info/warn/error/fatal)
 *   2. DEBUG=1 or DEBUG=true → debug
 *   3. default: info
 *
 * Exports:
 *   logger     — top-level logger (pino-shape)
 *   debug(ns)  — legacy API: returns { info, warn, error } scoped to ns
 *   logError   — `logError(msg, err?)` shortcut
 */

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVEL_RANK: Record<Level, number> = {
  trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60,
};

function resolveLevel(): Level {
  const env = (process.env.LOG_LEVEL || '').toLowerCase();
  if (env && env in LEVEL_RANK) return env as Level;
  if (process.env.DEBUG === '1' || process.env.DEBUG === 'true') return 'debug';
  return 'info';
}

const currentLevel: Level = resolveLevel();
const currentRank = LEVEL_RANK[currentLevel];

function serializeError(e: unknown): Record<string, unknown> {
  if (e instanceof Error) {
    return { name: e.name, message: e.message, stack: e.stack };
  }
  return { value: String(e) };
}

function emit(
  level: Level,
  baseFields: Record<string, unknown>,
  arg1: unknown,
  arg2?: unknown,
): void {
  if (LEVEL_RANK[level] < currentRank) return;
  const line: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    ...baseFields,
  };
  // pino calling convention:
  //   logger.warn(msg)
  //   logger.warn(obj, msg)
  //   logger.warn(obj)
  if (typeof arg1 === 'string') {
    line.msg = arg1;
  } else if (arg1 && typeof arg1 === 'object') {
    const obj = arg1 as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      line[k] = k === 'err' || k === 'error' ? serializeError(obj[k]) : obj[k];
    }
    if (typeof arg2 === 'string') line.msg = arg2;
  }
  try {
    process.stderr.write(JSON.stringify(line) + '\n');
  } catch {
    // stderr can be closed in some Electron embeddings — fall back to
    // console.error so we never crash the host on a log call.
    // eslint-disable-next-line no-console
    console.error(line);
  }
}

export interface PinoLikeLogger {
  trace: (arg1: unknown, arg2?: unknown) => void;
  debug: (arg1: unknown, arg2?: unknown) => void;
  info: (arg1: unknown, arg2?: unknown) => void;
  warn: (arg1: unknown, arg2?: unknown) => void;
  error: (arg1: unknown, arg2?: unknown) => void;
  fatal: (arg1: unknown, arg2?: unknown) => void;
  child: (bindings: Record<string, unknown>) => PinoLikeLogger;
  level: Level;
}

function makeLogger(baseFields: Record<string, unknown>): PinoLikeLogger {
  return {
    trace: (a, b) => emit('trace', baseFields, a, b),
    debug: (a, b) => emit('debug', baseFields, a, b),
    info: (a, b) => emit('info', baseFields, a, b),
    warn: (a, b) => emit('warn', baseFields, a, b),
    error: (a, b) => emit('error', baseFields, a, b),
    fatal: (a, b) => emit('fatal', baseFields, a, b),
    child: (bindings) => makeLogger({ ...baseFields, ...bindings }),
    level: currentLevel,
  };
}

export const logger: PinoLikeLogger = makeLogger({ name: 'makestudio' });

// ── Legacy API compatibility ───────────────────────────────────────────────────

export type Logger = {
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
};

/**
 * Legacy: `const log = debug('mymodule'); log.info('msg')`.
 * The namespace becomes a `ns` field in the JSON line.
 */
export function debug(namespace: string): Logger {
  const child = logger.child({ ns: namespace });
  return {
    info: (msg, data) => (data ? child.info(data, msg) : child.info(msg)),
    warn: (msg, data) => (data ? child.warn(data, msg) : child.warn(msg)),
    error: (msg, data) => (data ? child.error(data, msg) : child.error(msg)),
  };
}

/**
 * Legacy: `logError('msg', err)` — delegates to logger.error.
 */
export function logError(msg: string, err?: unknown): void {
  if (err instanceof Error) {
    logger.error({ err }, msg);
  } else if (err !== undefined) {
    logger.error({ extra: err }, msg);
  } else {
    logger.error(msg);
  }
}

/**
 * `swallow(err, label?)` — log-and-continue for previously empty catch
 * blocks. Same end-behaviour (the exception does NOT propagate), but the
 * line gets a structured warn entry so silent failures show up in stderr
 * and `~/.makestudio/debug/<session>.jsonl`. Use when the catch is
 * INTENTIONALLY non-fatal (cleanup that may race, optional dep that
 * isn't installed, etc.) — for true bugs use `logger.error` and rethrow.
 *
 * Label is optional: when omitted, the caller's stack frame is captured
 * so you can still find the call site in the log line. Pass an explicit
 * label when the caller's stack frame would be cryptic (anonymous arrow
 * inside an iterator, etc.).
 */
export function swallow(err: unknown, label?: string): void {
  let resolvedLabel = label;
  if (!resolvedLabel) {
    const stack = new Error().stack || '';
    // stack[0] = "Error" header, [1] = swallow itself, [2] = caller.
    const callerLine = stack.split('\n')[2] || '';
    const m = callerLine.match(/at\s+(?:(.+?)\s+)?\(?([^():]+):(\d+)/);
    resolvedLabel = m ? `${m[1] || '<anonymous>'} (${m[2].split('/').slice(-2).join('/')}:${m[3]})` : 'unknown';
  }
  logger.warn({ err, label: resolvedLabel }, 'swallowed exception');
}
