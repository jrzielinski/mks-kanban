import { swallow } from '../utils/log';
/**
 * telemetry.ts — local JSONL logger for decomposition events
 *
 * Records what actually happens during a per-requirement decomposition:
 * how long each phase takes, what causes retries, which CLI was used.
 * Persisted to `.makestudio/telemetry/decompose-YYYY-MM-DD.jsonl` so the
 * data survives across runs and can be aggregated later (locally or
 * shipped to the backend).
 *
 * Schema: one JSON object per line, parseable with any JSONL tool.
 * Required fields are always present; optional fields appear only when
 * the relevant phase actually happened.
 *
 * NOT a hot path — events are buffered in-memory and flushed on
 * `flush()` or process exit. fs writes are synchronous and rare (once
 * per req, max), so we don't need a worker or queue.
 */

import * as fs from 'fs';
import * as path from 'path';

export type TelemetryEventType =
  | 'req-start'
  | 'cli-spawned'
  | 'first-write'
  | 'validate-start'
  | 'validate-end'
  | 'save-end'
  | 'req-retry'
  | 'req-end'
  | 'loop-start'
  | 'loop-end';

/**
 * Common fields. Every event has these — they identify the run + req.
 */
export interface BaseTelemetryEvent {
  /** ISO timestamp at the moment the event was emitted. */
  ts: string;
  /** Stable id for the whole decomposition run (one per `start` invocation). */
  runId: string;
  /** 0-based index of the requirement within the run's queue. */
  reqIndex?: number;
  /** Stable id of the requirement (project requirement uuid). */
  reqId?: string;
  /** Short form of the req title — for human reading. */
  reqTitle?: string;
  /** Project id this run belongs to. */
  projectId: string;
  /** CLI used for this run/req (claude/codex/gemini/makestudio). */
  cli: string;
}

export type TelemetryEvent =
  | (BaseTelemetryEvent & { type: 'loop-start'; totalReqs: number })
  | (BaseTelemetryEvent & { type: 'loop-end'; totalReqs: number; saved: number; failed: number; durationMs: number })
  | (BaseTelemetryEvent & { type: 'req-start' })
  | (BaseTelemetryEvent & { type: 'cli-spawned'; attempt: number; promptBytes: number })
  | (BaseTelemetryEvent & { type: 'first-write'; attempt: number; sinceSpawnMs: number; tempId?: string })
  | (BaseTelemetryEvent & { type: 'validate-start'; tempId: string; setLevel: boolean })
  | (BaseTelemetryEvent & { type: 'validate-end'; tempId: string; passed: boolean; issuesCount: number; durationMs: number; topCriterion?: string })
  | (BaseTelemetryEvent & { type: 'save-end'; tempId: string; durationMs: number; success: boolean })
  | (BaseTelemetryEvent & { type: 'req-retry'; attempt: number; cause: string; failingTempIds: string[] })
  | (BaseTelemetryEvent & {
      type: 'req-end';
      success: boolean;
      retryCount: number;
      dumsSaved: number;
      timeToFirstWriteMs: number;
      timeToValidateMs: number;
      timeToSaveMs: number;
      totalDurationMs: number;
      tokensEstimated?: number;
      causeOfRetry?: string;
    });

/**
 * Distributive omit — needed so each member of the discriminated union
 * keeps its own `type` discriminator after stripping `ts`/`runId`.
 * Without this, TS would intersect into a useless `{ type: never }`.
 *
 * Also strips the fields baked in by the logger (projectId, cli) so
 * callers don't have to repeat them on every record() call.
 */
type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

export type TelemetryEventInput = DistributiveOmit<TelemetryEvent, 'ts' | 'runId' | 'projectId' | 'cli'>;

/**
 * Opaque handle returned by `createTelemetryLogger` — caller uses
 * `record()` to emit events and `flush()` to persist.
 */
export interface TelemetryLogger {
  runId: string;
  record(event: TelemetryEventInput): void;
  flush(): void;
  /**
   * Best-effort: ship the buffered events to the backend's telemetry
   * endpoint. Called automatically on loop-end; safe to no-op if the
   * api client / endpoint is unavailable.
   */
  syncToBackend(api: any): Promise<{ accepted: number; rejected: number } | null>;
  /** Filepath where events are being written (for display in CLI summary). */
  filePath: string;
  /** Disable the logger (no-op subsequent calls). Useful for tests. */
  disable(): void;
}

/**
 * Build the JSONL filepath for today's events. We bucket by date so a
 * long-running project produces multiple files instead of one giant log.
 */
function todayFilepath(cwd: string): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return path.join(cwd, '.makestudio', 'telemetry', `decompose-${y}-${m}-${d}.jsonl`);
}

/**
 * Generate a short stable id for a run. Not cryptographically random;
 * just unique enough to correlate events from the same loop.
 */
function makeRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(36)}`;
}

/**
 * Create a telemetry logger bound to a specific cwd + projectId + cli.
 * Events are buffered and written in batches to amortize fs cost.
 *
 * The `cli` and `projectId` are baked into the logger so callers don't
 * have to repeat them on every record() call.
 */
export function createTelemetryLogger(opts: {
  cwd: string;
  projectId: string;
  cli: string;
  /** Override autogenerated runId (useful for resume scenarios). */
  runId?: string;
}): TelemetryLogger {
  const filePath = todayFilepath(opts.cwd);
  const buffer: TelemetryEvent[] = [];
  // We keep ALL events emitted in this run (not just the active buffer)
  // so syncToBackend can ship a complete batch even after several flushes.
  const allEvents: TelemetryEvent[] = [];
  let active = true;
  const runId = opts.runId || makeRunId();

  // Flush on exit so events from a crashed run aren't lost. Best-effort —
  // signal handlers can't always guarantee delivery, but the loss window
  // is tiny because we also flush after each `req-end`.
  const exitHandler = () => {
    try { flush(); } catch (err) { swallow(err); }
  };
  process.once('beforeExit', exitHandler);
  process.once('SIGINT', exitHandler);
  process.once('SIGTERM', exitHandler);

  const flush = (): void => {
    if (!active || buffer.length === 0) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const lines = buffer.map((e) => JSON.stringify(e)).join('\n') + '\n';
      fs.appendFileSync(filePath, lines, 'utf8');
      buffer.length = 0;
    } catch {
      // Telemetry must never break the main flow. Drop the batch.
      buffer.length = 0;
    }
  };

  const record = (event: TelemetryEventInput): void => {
    if (!active) return;
    const full = {
      ...(event as object),
      ts: new Date().toISOString(),
      runId,
      projectId: opts.projectId,
      cli: opts.cli,
    } as TelemetryEvent;
    buffer.push(full);
    allEvents.push(full);

    // Flush eagerly on req-end/loop-end so a mid-run crash still leaves
    // useful data on disk. Other events accumulate up to 32 before flush.
    if (full.type === 'req-end' || full.type === 'loop-end' || buffer.length >= 32) {
      flush();
    }
  };

  const syncToBackend = async (
    api: any,
  ): Promise<{ accepted: number; rejected: number } | null> => {
    if (!active || allEvents.length === 0 || !api) return null;
    try {
      // Slice into chunks of 200 — backend caps single requests at 1000
      // events but smaller batches keep retry latency low if the network
      // hiccups halfway through.
      const chunkSize = 200;
      let acceptedTotal = 0;
      let rejectedTotal = 0;
      for (let i = 0; i < allEvents.length; i += chunkSize) {
        const chunk = allEvents.slice(i, i + chunkSize);
        const res = await api.post(
          `/dark-factory/telemetry/decompose`,
          { events: chunk },
          { timeout: 15_000 },
        );
        acceptedTotal += res.data?.accepted || 0;
        rejectedTotal += res.data?.rejected || 0;
      }
      return { accepted: acceptedTotal, rejected: rejectedTotal };
    } catch {
      // Telemetry sync is best-effort — never crash the main flow.
      return null;
    }
  };

  return {
    runId,
    record,
    flush,
    syncToBackend,
    filePath,
    disable: () => {
      active = false;
      buffer.length = 0;
      allEvents.length = 0;
    },
  };
}

/**
 * Aggregate a JSONL file into summary stats. Used by the
 * `makestudio telemetry` command and (later) the backend endpoint.
 */
export interface TelemetrySummary {
  totalRuns: number;
  totalRequirements: number;
  successfulRequirements: number;
  failedRequirements: number;
  retryRate: number; // 0-1
  avgTimeToFirstWriteMs: number;
  avgTimeToValidateMs: number;
  avgTimeToSaveMs: number;
  avgTotalDurationMs: number;
  topCausesOfRetry: Array<{ cause: string; count: number }>;
  byCli: Map<string, { count: number; avgMs: number; retryRate: number }>;
}

export function summarizeJsonl(filePath: string): TelemetrySummary {
  const empty: TelemetrySummary = {
    totalRuns: 0,
    totalRequirements: 0,
    successfulRequirements: 0,
    failedRequirements: 0,
    retryRate: 0,
    avgTimeToFirstWriteMs: 0,
    avgTimeToValidateMs: 0,
    avgTimeToSaveMs: 0,
    avgTotalDurationMs: 0,
    topCausesOfRetry: [],
    byCli: new Map(),
  };
  if (!fs.existsSync(filePath)) return empty;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return empty;
  }

  const events: TelemetryEvent[] = [];
  for (const line of raw.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines — happens if a process crashed mid-write.
    }
  }
  if (events.length === 0) return empty;

  const runIds = new Set<string>();
  const reqEnds = events.filter((e): e is Extract<TelemetryEvent, { type: 'req-end' }> => e.type === 'req-end');
  const causes = new Map<string, number>();
  const byCli = new Map<string, { count: number; totalMs: number; retried: number }>();

  for (const e of events) runIds.add(e.runId);

  let sumFirstWrite = 0;
  let sumValidate = 0;
  let sumSave = 0;
  let sumTotal = 0;
  let retried = 0;
  let success = 0;
  let failed = 0;

  for (const e of reqEnds) {
    sumFirstWrite += e.timeToFirstWriteMs;
    sumValidate += e.timeToValidateMs;
    sumSave += e.timeToSaveMs;
    sumTotal += e.totalDurationMs;
    if (e.retryCount > 0) retried++;
    if (e.success) success++;
    else failed++;
    if (e.causeOfRetry) {
      causes.set(e.causeOfRetry, (causes.get(e.causeOfRetry) || 0) + 1);
    }
    const cli = e.cli;
    const bucket = byCli.get(cli) || { count: 0, totalMs: 0, retried: 0 };
    bucket.count++;
    bucket.totalMs += e.totalDurationMs;
    if (e.retryCount > 0) bucket.retried++;
    byCli.set(cli, bucket);
  }

  const n = reqEnds.length;
  const summary: TelemetrySummary = {
    totalRuns: runIds.size,
    totalRequirements: n,
    successfulRequirements: success,
    failedRequirements: failed,
    retryRate: n > 0 ? retried / n : 0,
    avgTimeToFirstWriteMs: n > 0 ? Math.round(sumFirstWrite / n) : 0,
    avgTimeToValidateMs: n > 0 ? Math.round(sumValidate / n) : 0,
    avgTimeToSaveMs: n > 0 ? Math.round(sumSave / n) : 0,
    avgTotalDurationMs: n > 0 ? Math.round(sumTotal / n) : 0,
    topCausesOfRetry: [...causes.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([cause, count]) => ({ cause, count })),
    byCli: new Map(
      [...byCli.entries()].map(([cli, b]) => [
        cli,
        { count: b.count, avgMs: Math.round(b.totalMs / b.count), retryRate: b.retried / b.count },
      ]),
    ),
  };
  return summary;
}

/**
 * Locate all decompose-*.jsonl files in `.makestudio/telemetry/` (sorted
 * descending by date). Used by the `telemetry` command to default to the
 * most recent file when the user doesn't specify one.
 */
export function listTelemetryFiles(cwd: string): string[] {
  const dir = path.join(cwd, '.makestudio', 'telemetry');
  try {
    return fs.readdirSync(dir)
      .filter((f) => /^decompose-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
      .reverse()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}
