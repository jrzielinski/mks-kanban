import { swallow } from '../utils/log';
/**
 * Scheduled tasks — persistent cron-like schedules stored in ~/.makestudio/schedule.json
 *
 * Format:
 *   {
 *     "schedules": [
 *       { "id": "uuid", "name": "nightly-audit", "cron": "0 2 * * *",
 *         "command": "/analyze --audit --project-id abc", "enabled": true,
 *         "lastRunAt": "2026-04-17T02:00:00Z", "nextRunAt": "2026-04-18T02:00:00Z" }
 *     ]
 *   }
 *
 * Runtime: a lightweight poller in the REPL checks every minute.
 * For long-running schedules while REPL is closed, user can install a
 * crontab entry that runs `makestudio scheduled-run`.
 *
 * Features:
 *   - Durable (file-backed) + session-only (in-memory) tasks
 *   - Deterministic jitter by task id (avoids thundering herd on :00)
 *   - Missed-task detection (logs tasks that should have fired while offline)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

export interface Schedule {
  id: string;
  name: string;
  cron: string;
  command: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  /** When false, task lives in memory only — never persisted to disk. Default true. */
  durable?: boolean;
}

const SCHEDULE_FILE = path.join(os.homedir(), '.makestudio', 'schedule.json');

// ── In-memory session-only tasks (durable: false) ──────────────
const sessionSchedules: Schedule[] = [];

export function addSessionSchedule(name: string, cron: string, command: string): Schedule {
  const schedule: Schedule = {
    id: randomUUID(),
    name,
    cron,
    command,
    enabled: true,
    createdAt: new Date().toISOString(),
    nextRunAt: computeNextRun(cron),
    durable: false,
  };
  sessionSchedules.push(schedule);
  return schedule;
}

export function removeSessionSchedule(idOrName: string): boolean {
  const idx = sessionSchedules.findIndex((s) => s.id === idOrName || s.name === idOrName);
  if (idx === -1) return false;
  sessionSchedules.splice(idx, 1);
  return true;
}

// ── Deterministic jitter ───────────────────────────────────────
// Ported from claude-code/src/utils/cronTasks.ts (jitterFrac, jitteredNextCronRunMs).
// DJB2 hash of the task id → deterministic [0, 1) fraction, stable across restarts.

function djb2(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0; // 32-bit signed overflow
  }
  return hash >>> 0; // unsigned
}

function jitterFrac(taskId: string): number {
  const h = djb2(taskId);
  return (h % 0x1_0000_0000) / 0x1_0000_0000;
}

/** Maximum jitter for any single task fire. */
const JITTER_CAP_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Compute next run and add deterministic jitter proportional to the
 * interval between cron fires. Same task id → same jitter across
 * restarts and across instances sharing the same schedule.json.
 */
export function computeNextRunJittered(cron: string, taskId: string, from?: Date): string {
  const t1Ms = new Date(computeNextRun(cron, from)).getTime();
  const t2Ms = new Date(computeNextRun(cron, new Date(t1Ms + 60_000))).getTime();
  if (!Number.isFinite(t2Ms)) {
    // No second match in the lookahead window — fire on t1 without jitter.
    return new Date(t1Ms).toISOString();
  }
  const intervalMs = t2Ms - t1Ms;
  // For short intervals (< 10 min), interval * 0.1 < 1 min, which is
  // usually plenty to spread a herd. For long intervals (> 2.5h), the
  // cap kicks in first to prevent multi-hour skew.
  const jitter = Math.min(
    jitterFrac(taskId) * intervalMs * 0.1,
    JITTER_CAP_MS,
  );
  return new Date(t1Ms + jitter).toISOString();
}

// ── Missed-task detection ──────────────────────────────────────
// Ported from claude-code/src/utils/cronTasks.ts (findMissedTasks).
// A task is "missed" when its computed next run (anchored on createdAt
// or lastRunAt) is in the past — meaning at least one fire window was
// skipped while the process was offline.

export interface MissedTask extends Schedule {
  missedFrom: string; // ISO string of the missed fire window
}

/**
 * Find tasks whose next scheduled fire time is in the past, indicating
 * at least one missed run. For file-backed tasks, uses the persisted
 * `nextRunAt` as anchor. For session-only tasks, uses `createdAt`.
 * Recomputes from `lastRunAt ?? createdAt` for reliability.
 */
export function findMissedTasks(tasks: Schedule[], now: Date = new Date()): MissedTask[] {
  const result: MissedTask[] = [];
  for (const t of tasks) {
    if (!t.enabled) continue;
    const anchor = t.lastRunAt ?? t.createdAt;
    const missedFire = computeNextRun(t.cron, new Date(anchor));
    if (missedFire && new Date(missedFire) <= now) {
      result.push({ ...t, missedFrom: missedFire });
    }
  }
  return result;
}

// ── File-backed tasks (durable) ─────────────────────────────────

export function loadSchedules(): Schedule[] {
  try {
    if (!fs.existsSync(SCHEDULE_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
    return data.schedules || [];
  } catch {
    return [];
  }
}

export function saveSchedules(schedules: Schedule[]): void {
  // Strip session-only tasks — they live in sessionSchedules[] and are
  // never persisted. This keeps schedule.json purely file-backed.
  const durable = schedules.filter((s) => s.durable !== false);
  try {
    fs.mkdirSync(path.dirname(SCHEDULE_FILE), { recursive: true });
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify({ schedules: durable }, null, 2), 'utf8');
  } catch (err) { swallow(err); }
}

/**
 * Combine file-backed and session-only tasks into one list. Session
 * tasks are appended last so callers see the full picture (poller,
 * /schedule list).
 */
export function listAllSchedules(): Schedule[] {
  return [...loadSchedules(), ...sessionSchedules];
}

export function addSchedule(name: string, cron: string, command: string, durable: boolean = true): Schedule {
  if (!durable) {
    return addSessionSchedule(name, cron, command);
  }
  const schedules = loadSchedules();
  const id = randomUUID();
  const schedule: Schedule = {
    id,
    name,
    cron,
    command,
    enabled: true,
    createdAt: new Date().toISOString(),
    nextRunAt: computeNextRunJittered(cron, id),
  };
  schedules.push(schedule);
  saveSchedules(schedules);
  return schedule;
}

export function removeSchedule(idOrName: string): boolean {
  const schedules = loadSchedules();
  const idx = schedules.findIndex((s) => s.id === idOrName || s.name === idOrName);
  if (idx === -1) {
    // Not in file — try session store
    return removeSessionSchedule(idOrName);
  }
  schedules.splice(idx, 1);
  saveSchedules(schedules);
  return true;
}

export function toggleSchedule(idOrName: string, enabled: boolean): boolean {
  // Check file-backed first
  const schedules = loadSchedules();
  const s = schedules.find((x) => x.id === idOrName || x.name === idOrName);
  if (s) {
    s.enabled = enabled;
    saveSchedules(schedules);
    return true;
  }
  // Try session store
  const ss = sessionSchedules.find((x) => x.id === idOrName || x.name === idOrName);
  if (ss) {
    ss.enabled = enabled;
    return true;
  }
  return false;
}

/**
 * Compute next run time from a cron expression.
 * Full POSIX cron subset:
 *   minute (0-59), hour (0-23), day-of-month (1-31), month (1-12), day-of-week (0-6, 0=Sun)
 * Supports:
 *   *                 — any value in range
 *   N                 — literal value
 *   N-M               — inclusive range
 *   N,M,...           — list of values
 *   * / S             — every S starting from field's minimum
 *   N-M/S             — every S within the N-M range
 *   @hourly/@daily/@weekly/@monthly/@midnight — shortcuts
 *   Month names: jan,feb,mar,apr,may,jun,jul,aug,sep,oct,nov,dec (case-insensitive)
 *   Day names: sun,mon,tue,wed,thu,fri,sat (case-insensitive)
 *
 * POSIX quirk preserved: when BOTH day-of-month AND day-of-week are restricted
 * (neither is `*`), the rule fires on EITHER match (OR semantics), not both.
 * Matches the BSD/Vixie cron behaviour most users expect.
 */
const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DAY_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function normaliseField(field: string, names?: Record<string, number>): string {
  if (!names) return field;
  return field.toLowerCase().replace(/[a-z]{3,}/g, (w) => (w in names ? String(names[w]) : w));
}

/** Parse one cron field into a predicate function. `min`/`max` define the
 *  field's valid range; invalid values are silently dropped (better UX
 *  than rejecting the whole expression for a typo'd day name). */
function fieldMatcher(field: string, min: number, max: number, names?: Record<string, number>): (v: number) => boolean {
  const normalised = normaliseField(field.trim(), names);
  if (!normalised || normalised === '*') return () => true;

  // Lists — split on comma, combine matchers with OR.
  if (normalised.includes(',')) {
    const parts = normalised.split(',').map((p) => fieldMatcher(p, min, max, names));
    return (v) => parts.some((fn) => fn(v));
  }

  // Step: `<range>/<step>` — range can be `*`, a number, or `a-b`.
  if (normalised.includes('/')) {
    const [rangeStr, stepStr] = normalised.split('/');
    const step = parseInt(stepStr, 10);
    if (!Number.isFinite(step) || step <= 0) return () => false;
    let lo = min;
    let hi = max;
    if (rangeStr === '*') {
      // full range
    } else if (rangeStr.includes('-')) {
      const [a, b] = rangeStr.split('-').map((n) => parseInt(n, 10));
      if (!Number.isFinite(a) || !Number.isFinite(b)) return () => false;
      lo = a; hi = b;
    } else {
      const n = parseInt(rangeStr, 10);
      if (!Number.isFinite(n)) return () => false;
      lo = n; hi = max;
    }
    return (v) => v >= lo && v <= hi && (v - lo) % step === 0;
  }

  // Range: `a-b` inclusive.
  if (normalised.includes('-')) {
    const [a, b] = normalised.split('-').map((n) => parseInt(n, 10));
    if (!Number.isFinite(a) || !Number.isFinite(b)) return () => false;
    return (v) => v >= a && v <= b;
  }

  // Literal.
  const n = parseInt(normalised, 10);
  if (!Number.isFinite(n)) return () => false;
  return (v) => v === n;
}

export function computeNextRun(cron: string, from: Date = new Date()): string {
  const shortcuts: Record<string, string> = {
    '@hourly':   '0 * * * *',
    '@daily':    '0 0 * * *',
    '@midnight': '0 0 * * *',
    '@weekly':   '0 0 * * 0',
    '@monthly':  '0 0 1 * *',
    '@yearly':   '0 0 1 1 *',
    '@annually': '0 0 1 1 *',
  };
  const expr = shortcuts[cron.trim()] || cron.trim();
  const parts = expr.split(/\s+/);
  // Fallback for malformed expressions — run in an hour. Better than
  // throwing and breaking the REPL loop.
  if (parts.length !== 5) return new Date(from.getTime() + 3600_000).toISOString();

  const [mMin, mHour, mDom, mMon, mDow] = parts;
  const matchMin  = fieldMatcher(mMin,  0, 59);
  const matchHour = fieldMatcher(mHour, 0, 23);
  const matchDom  = fieldMatcher(mDom,  1, 31);
  const matchMon  = fieldMatcher(mMon,  1, 12, MONTH_NAMES);
  const matchDow  = fieldMatcher(mDow,  0, 6,  DAY_NAMES);

  // POSIX day-or-day quirk: when BOTH dom and dow are restricted, either
  // match suffices. When one is `*`, the other is authoritative.
  const domRestricted = mDom !== '*';
  const dowRestricted = mDow !== '*';
  const dayMatches = (d: Date): boolean => {
    if (domRestricted && dowRestricted) {
      return matchDom(d.getDate()) || matchDow(d.getDay());
    }
    return matchDom(d.getDate()) && matchDow(d.getDay());
  };

  // Search up to 366 days ahead in 1-minute increments (capped iterations).
  let d = new Date(from.getTime() + 60_000);
  d.setSeconds(0, 0);
  const MAX_ITER = 366 * 24 * 60;
  for (let i = 0; i < MAX_ITER; i++) {
    if (matchMin(d.getMinutes()) && matchHour(d.getHours()) && matchMon(d.getMonth() + 1) && dayMatches(d)) {
      return d.toISOString();
    }
    d = new Date(d.getTime() + 60_000);
  }
  // Genuinely never fires in the next year — return something sane so the
  // caller doesn't crash. User's cron expression is probably bad.
  return new Date(from.getTime() + 366 * 24 * 3600_000).toISOString();
}

export function listDueSchedules(now: Date = new Date()): Schedule[] {
  return listAllSchedules().filter((s) => s.enabled && s.nextRunAt && new Date(s.nextRunAt) <= now);
}

export function markRan(id: string): void {
  // Check file-backed first
  const schedules = loadSchedules();
  const s = schedules.find((x) => x.id === id);
  if (s) {
    s.lastRunAt = new Date().toISOString();
    s.nextRunAt = computeNextRunJittered(s.cron, s.id);
    saveSchedules(schedules);
    return;
  }
  // Try session store
  const ss = sessionSchedules.find((x) => x.id === id);
  if (ss) {
    ss.lastRunAt = new Date().toISOString();
    ss.nextRunAt = computeNextRunJittered(ss.cron, ss.id);
  }
}

// ── Run history ────────────────────────────────────────────────────────
//
// Persisted ledger of every schedule execution: timing, exit code, output
// tail, error. Single source of truth used by the SchedulePage's expanded
// row (last 10 runs per schedule) and surfaces both daemon/poller/manual
// trigger origins. File grows append-only with a global FIFO cap so
// long-running setups don't blow up disk.

const SCHEDULE_RUNS_FILE = path.join(os.homedir(), '.makestudio', 'schedule-runs.json');
const SCHEDULE_RUNS_GLOBAL_CAP = 500;
const SCHEDULE_RUNS_PER_ID_CAP = 100;
const SCHEDULE_RUNS_OUTPUT_CAP = 4096;

export interface ScheduleRun {
  runId: string;
  scheduleId: string;
  ranAt: string;          // ISO
  durationMs: number;
  exitCode: number | null;
  outputTail: string;     // last ~4KB of stdout+stderr
  error?: string;
  trigger: 'poller' | 'daemon' | 'manual';
}

function loadAllRunsRaw(): ScheduleRun[] {
  try {
    if (!fs.existsSync(SCHEDULE_RUNS_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(SCHEDULE_RUNS_FILE, 'utf8'));
    return Array.isArray(data?.runs) ? (data.runs as ScheduleRun[]) : [];
  } catch {
    return [];
  }
}

function saveAllRuns(runs: ScheduleRun[]): void {
  try {
    fs.mkdirSync(path.dirname(SCHEDULE_RUNS_FILE), { recursive: true });
    fs.writeFileSync(SCHEDULE_RUNS_FILE, JSON.stringify({ runs }, null, 2), 'utf8');
  } catch (err) { swallow(err); }
}

function truncateOutput(s: string | undefined): string {
  if (!s) return '';
  if (s.length <= SCHEDULE_RUNS_OUTPUT_CAP) return s;
  // Keep tail — that's where errors usually appear.
  return '…[truncated]…\n' + s.slice(-SCHEDULE_RUNS_OUTPUT_CAP);
}

export function recordRun(run: Omit<ScheduleRun, 'runId'>): ScheduleRun {
  const full: ScheduleRun = {
    ...run,
    runId: randomUUID(),
    outputTail: truncateOutput(run.outputTail),
  };
  const runs = loadAllRunsRaw();
  runs.push(full);
  // FIFO eviction per scheduleId — drops the oldest run-records belonging to
  // the same scheduleId once it crosses SCHEDULE_RUNS_PER_ID_CAP. Without
  // this, a chatty schedule can starve out history of quieter schedules
  // before the global cap kicks in.
  const sameId = runs
    .map((r, idx) => ({ r, idx }))
    .filter((e) => e.r.scheduleId === full.scheduleId);
  if (sameId.length > SCHEDULE_RUNS_PER_ID_CAP) {
    const toDrop = new Set(
      sameId
        .sort((a, b) => (a.r.ranAt < b.r.ranAt ? -1 : 1))
        .slice(0, sameId.length - SCHEDULE_RUNS_PER_ID_CAP)
        .map((e) => e.idx),
    );
    for (let i = runs.length - 1; i >= 0; i--) {
      if (toDrop.has(i)) runs.splice(i, 1);
    }
  }
  // Global FIFO eviction — keeps the most recent SCHEDULE_RUNS_GLOBAL_CAP overall.
  if (runs.length > SCHEDULE_RUNS_GLOBAL_CAP) {
    runs.splice(0, runs.length - SCHEDULE_RUNS_GLOBAL_CAP);
  }
  saveAllRuns(runs);
  return full;
}

export function listRunsForSchedule(scheduleId: string, limit = 10): ScheduleRun[] {
  const all = loadAllRunsRaw();
  // Most recent first.
  const filtered = all
    .filter((r) => r.scheduleId === scheduleId)
    .sort((a, b) => (a.ranAt < b.ranAt ? 1 : -1));
  return filtered.slice(0, Math.max(0, limit));
}

export function listAllRuns(limit = 50): ScheduleRun[] {
  const all = loadAllRunsRaw();
  return all
    .slice()
    .sort((a, b) => (a.ranAt < b.ranAt ? 1 : -1))
    .slice(0, Math.max(0, limit));
}
