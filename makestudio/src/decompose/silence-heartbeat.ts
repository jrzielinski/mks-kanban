import { swallow } from '../utils/log';
/**
 * silence-heartbeat.ts
 *
 * When the inner CLI subprocess emits stdout/stderr in bursts (one tool
 * call followed by 30-90s of provider round-trip silence), the parent
 * looks frozen to the user — they cancel after a few minutes thinking it
 * hung, when in fact the LLM was just thinking.
 *
 * This helper wraps the parent's "I'm waiting for the subprocess" with a
 * lightweight ticker that periodically writes a status line to stdout
 * after a quiet period. The ticker is reset on every chunk of subprocess
 * activity, so during a busy stream you see nothing extra; only during
 * the silent gaps does the heartbeat fire.
 *
 * Format (kept in sync with the JSONL stream formatter's `· …` style):
 *   ` │    · aguardando resposta do LLM · 15s`
 *   ` │    · aguardando resposta do LLM · 30s · cancele com Ctrl+C`
 *
 * Usage:
 *   const hb = startSilenceHeartbeat({ prefix: '  │    ', threshold: 8000 });
 *   proc.stdout.on('data', () => hb.markActivity());
 *   proc.stderr.on('data', () => hb.markActivity());
 *   proc.on('close', () => hb.stop());
 */
import chalk from 'chalk';

const dim = chalk.hex('#64748B');

export interface SilenceHeartbeatOptions {
  /** Prefix prepended to every heartbeat line (so it lines up under the
   *  current decomposition step's indentation). */
  prefix?: string;
  /** ms of quiet after the last activity before the FIRST heartbeat fires.
   *  Default 8000 (8s) — short enough to reassure quickly, long enough to
   *  not pollute output when the stream is healthy. */
  threshold?: number;
  /** ms between subsequent heartbeats once silence is detected.
   *  Default 7000 (7s). */
  interval?: number;
  /** When the silence has lasted this many seconds, append a hint about
   *  cancelling. Default 30 — past this most users start questioning. */
  hintAfterSeconds?: number;
  /** Custom write target. Defaults to process.stdout.write. Used by tests
   *  to capture lines without touching the real stdout. */
  write?: (line: string) => void;
  /** Clock injection for tests. Defaults to Date.now. */
  now?: () => number;
}

export interface SilenceHeartbeat {
  /** Reset the silence timer. Call when a chunk of subprocess output
   *  arrives — the heartbeat re-arms from zero. */
  markActivity(): void;
  /** Stop firing. Call on subprocess close/error. Idempotent. */
  stop(): void;
  /** True while the ticker is alive. Mostly for tests. */
  isActive(): boolean;
}

export function startSilenceHeartbeat(opts: SilenceHeartbeatOptions = {}): SilenceHeartbeat {
  const prefix = opts.prefix ?? '  │    ';
  const threshold = opts.threshold ?? 8_000;
  const interval = opts.interval ?? 7_000;
  const hintAfter = (opts.hintAfterSeconds ?? 30) * 1000;
  const write = opts.write ?? ((s: string) => process.stdout.write(s));
  const now = opts.now ?? Date.now;

  let lastActivity = now();
  let lastHeartbeatAt = 0;
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    const t = now();
    const silentMs = t - lastActivity;
    if (silentMs >= threshold && (t - lastHeartbeatAt) >= interval) {
      const seconds = Math.floor(silentMs / 1000);
      const hint = silentMs >= hintAfter ? ` · ${dim('cancele com Ctrl+C')}` : '';
      write(`${prefix}${dim('·')} ${dim(`aguardando resposta do LLM · ${seconds}s`)}${hint}\n`);
      lastHeartbeatAt = t;
    }
  };

  // Drive the ticker on a fixed cadence — lower than `interval` so we
  // don't miss the threshold by much. unref() so an abandoned heartbeat
  // never keeps the process alive.
  const timer = setInterval(tick, Math.min(threshold, interval, 3_000));
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    try { (timer as NodeJS.Timeout).unref(); } catch (err) { swallow(err); }
  }

  return {
    markActivity(): void {
      lastActivity = now();
      // Reset the heartbeat clock too — otherwise a single chunk between
      // heartbeats would let the next one fire instantly.
      lastHeartbeatAt = now();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
    isActive(): boolean {
      return !stopped;
    },
  };
}
