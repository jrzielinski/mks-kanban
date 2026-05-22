/**
 * debug-log.ts — session audit trail for post-mortem analysis.
 *
 * Writes one JSON line per event to:
 *   ~/.makestudio/debug/<sessionId>.jsonl
 *   ~/.makestudio/debug/latest  (symlink → current session)
 *
 * Activated by:
 *   makestudio --debug
 *   DEBUG=1 makestudio
 *   /debug  (toggles at runtime)
 *
 * Every recorded event has at minimum: { ts, type }.
 * Events: bash_start, bash_stdout, bash_stderr, bash_end,
 *         tool_call, tool_result, llm_request, llm_chunk,
 *         llm_response, permission_prompt, permission_choice,
 *         error, warn, info, session_start, session_end.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger, swallow } from '../utils/log';

// ── State ─────────────────────────────────────────────────────────────────────

let enabled = false;
let logPath: string | null = null;
let fd: number | null = null;

const SESSION_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

// ── Init ──────────────────────────────────────────────────────────────────────

export function initDebugLog(forceEnable?: boolean): void {
  enabled = forceEnable ?? (process.env.DEBUG === '1' || process.argv.includes('--debug'));
  if (!enabled) return;

  const dir = path.join(os.homedir(), '.makestudio', 'debug');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) { logger.warn({ err }, 'mkdir debug dir failed'); return; }

  logPath = path.join(dir, `${SESSION_ID}.jsonl`);
  try {
    fd = fs.openSync(logPath, 'a');
  } catch (err) { logger.warn({ err }, 'open debug log failed'); return; }

  // Update ~/.makestudio/debug/latest symlink
  const latest = path.join(dir, 'latest');
  try {
    if (fs.existsSync(latest)) fs.unlinkSync(latest);
    fs.symlinkSync(logPath, latest);
  } catch (err) { swallow(err); }

  writeEvent({ type: 'session_start', sessionId: SESSION_ID, pid: process.pid, argv: process.argv.slice(2) });
}

export function isDebugEnabled(): boolean { return enabled; }
export function getDebugLogPath(): string | null { return logPath; }
export function getSessionId(): string { return SESSION_ID; }

export function enableDebugLog(): void {
  if (!enabled) initDebugLog(true);
  else enabled = true;
}

export function disableDebugLog(): void {
  enabled = false;
}

// ── Writer ────────────────────────────────────────────────────────────────────

function writeEvent(payload: Record<string, unknown>): void {
  if (!enabled || fd === null) return;
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...payload }) + '\n';
    fs.writeSync(fd, line);
  } catch (err) { logger.error({ err }, 'write debug event failed'); }
}

// ── Public helpers ────────────────────────────────────────────────────────────

export function dbgInfo(msg: string, extra?: Record<string, unknown>): void {
  writeEvent({ type: 'info', msg, ...extra });
}

export function dbgWarn(msg: string, extra?: Record<string, unknown>): void {
  writeEvent({ type: 'warn', msg, ...extra });
}

export function dbgError(msg: string, extra?: Record<string, unknown>): void {
  writeEvent({ type: 'error', msg, ...extra });
}

// ── Tool events ───────────────────────────────────────────────────────────────

export function dbgToolCall(toolName: string, input: unknown): void {
  if (!enabled) return;
  const safeInput = sanitizeInput(toolName, input);
  writeEvent({ type: 'tool_call', tool: toolName, input: safeInput });
}

export function dbgToolResult(toolName: string, output: string, durationMs: number): void {
  writeEvent({ type: 'tool_result', tool: toolName, durationMs, outputLen: output.length,
    outputSnippet: output.slice(0, 400) });
}

// ── Bash-specific ──────────────────────────────────────────────────────────────

export function dbgBashStart(cmd: string, cwd: string, timeout: number): void {
  writeEvent({ type: 'bash_start', cmd, cwd, timeout });
}

export function dbgBashStdout(chunk: string): void {
  if (!enabled) return;
  writeEvent({ type: 'bash_stdout', chunk: chunk.slice(0, 2000) });
}

export function dbgBashStderr(chunk: string): void {
  if (!enabled) return;
  writeEvent({ type: 'bash_stderr', chunk: chunk.slice(0, 2000) });
}

export function dbgBashEnd(exitCode: number, durationMs: number, stdout: string, stderr: string): void {
  writeEvent({
    type: 'bash_end', exitCode, durationMs,
    stdoutLen: stdout.length, stderrLen: stderr.length,
    stdoutSnippet: stdout.slice(0, 800), stderrSnippet: stderr.slice(0, 400),
  });
}

// ── LLM events ────────────────────────────────────────────────────────────────

export function dbgLlmRequest(model: string, msgCount: number, systemLen: number): void {
  writeEvent({ type: 'llm_request', model, msgCount, systemLen });
}

export function dbgLlmResponse(model: string, text: string, tokensOut: number, durationMs: number): void {
  writeEvent({
    type: 'llm_response', model, tokensOut, durationMs,
    textSnippet: text.slice(0, 600),
  });
}

// ── Permission events ──────────────────────────────────────────────────────────

export function dbgPermissionPrompt(toolName: string, preview: string): void {
  writeEvent({ type: 'permission_prompt', tool: toolName, preview });
}

export function dbgPermissionChoice(toolName: string, choice: string): void {
  writeEvent({ type: 'permission_choice', tool: toolName, choice });
}

// ── Memory diagnostics ─────────────────────────────────────────────────────────
// Snapshot all the structures that could plausibly grow unbounded. Run via
// dbgMemSnapshot() periodically (every tool call) and dbgFullMemSnapshot()
// on demand (slash-command or auto-trigger when heap > threshold).
//
// The goal is post-mortem leak analysis: scan a session's debug.jsonl for
// `mem_snapshot` events, plot rss/heapUsed against tool-call sequence, and
// see which counter is climbing in step. The structures listed here cover
// every place I could find that retains references between turns.

interface MemSnapshot {
  type: 'mem_snapshot';
  // Process-level
  rss: number;             // resident set (bytes)
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  // Tool-call cursor — set by caller so the snapshot lines up with a tool
  // sequence number. Helps pinpoint WHICH tool call started the climb.
  seq?: number;
  trigger?: string;        // 'tool_end' | 'manual' | 'auto_threshold' | …
  // ctx state (chat history)
  ctxMessagesCount?: number;
  ctxMessagesBytes?: number;
  // TUI state
  tuiMessagesCount?: number;
  tuiMessagesBytes?: number;
  pastedTextsCount?: number;
  pastedTextsBytes?: number;
  // Listeners that might leak on subscribe-without-unsubscribe paths
  messageHooks?: number;
  pickerListeners?: number;
  toastListeners?: number;
  permListeners?: number;
  usageListeners?: number;
  transientSubs?: number;
  // External processes that survive across turns
  childProcessCount?: number;     // nodes child_process active count (lsp/tsc-watch/bash bg)
  // Subagent + cluster
  subagentPoolSize?: number;
  coordinatorWorkers?: number;
  // LSP cache
  lspDiagnosticFiles?: number;
  lspDiagnosticEntries?: number;
  // Read tracking
  readPathsCount?: number;
  readCacheCount?: number;
  // Trajectory state
  trajectoryEventCount?: number;  // seq counter, not bytes
  // Misc
  eventEmitterListenerCount?: number;
  stdinListeners?: number;
  stdoutListeners?: number;
}

function safeGet<T>(getter: () => T): T | undefined {
  try { return getter(); } catch { return undefined; }
}

function bytesOf(s: unknown): number {
  if (typeof s === 'string') return Buffer.byteLength(s, 'utf8');
  if (s == null) return 0;
  try { return Buffer.byteLength(JSON.stringify(s), 'utf8'); } catch { return 0; }
}

/** Build a memory snapshot. Cheap to call (no GC, no V8 internal walk). */
export function captureMemSnapshot(opts: { ctx?: any; trigger?: string; seq?: number } = {}): MemSnapshot {
  const mem = process.memoryUsage();
  const snap: MemSnapshot = {
    type: 'mem_snapshot',
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
    trigger: opts.trigger,
    seq: opts.seq,
  };

  // ctx.messages — chat history
  const ctx = opts.ctx;
  if (ctx?.messages) {
    snap.ctxMessagesCount = ctx.messages.length;
    let bytes = 0;
    for (const m of ctx.messages) {
      bytes += bytesOf(m.content);
      if (m.reasoning_content) bytes += bytesOf(m.reasoning_content);
    }
    snap.ctxMessagesBytes = bytes;
  }

  // TUI bridge state — all the listener Sets and the pastedTexts Map.
  // The bridge module exports these via getters added below.
  safeGet(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const b = require('./tui/bridge');
    if (typeof b.__debugCounts === 'function') {
      Object.assign(snap, b.__debugCounts());
    }
  });

  // App.tsx tracks tuiMessages but it's React state — surfaced via a global
  // hook the App can install on mount.
  safeGet(() => {
    const stats = (global as any).__makestudio_tuiStats;
    if (stats && typeof stats === 'function') {
      const s = stats();
      if (s) {
        snap.tuiMessagesCount = s.count;
        snap.tuiMessagesBytes = s.bytes;
      }
    }
  });

  // Active subprocesses
  safeGet(() => {
    const procs = (global as any).__makestudio_activeChildProcs;
    if (procs && typeof procs === 'function') {
      snap.childProcessCount = procs();
    }
  });

  // LSP diagnostics cache
  safeGet(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const lsp = require('./lsp');
    if (typeof lsp.__debugCounts === 'function') {
      const s = lsp.__debugCounts();
      snap.lspDiagnosticFiles = s.files;
      snap.lspDiagnosticEntries = s.entries;
    }
  });

  // Read-path tracking
  safeGet(() => {
    if (ctx?.readCache) snap.readCacheCount = ctx.readCache.size;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const r = require('./ai/file-tools/path-utils');
    if (typeof r.__debugReadPathsCount === 'function') {
      snap.readPathsCount = r.__debugReadPathsCount(ctx);
    }
  });

  // Subagent pool
  safeGet(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const s = require('./ai/subagent-pool');
    if (typeof s.__debugPoolSize === 'function') {
      snap.subagentPoolSize = s.__debugPoolSize();
    }
  });

  // Coordinator workers
  if (ctx?.coordinatorWorkers && typeof ctx.coordinatorWorkers.size === 'number') {
    snap.coordinatorWorkers = ctx.coordinatorWorkers.size;
  }

  // Process-level event emitters (listener counts on stdin/stdout)
  safeGet(() => {
    snap.stdinListeners = (process.stdin as any).listenerCount('data') || 0;
    snap.stdoutListeners = (process.stdout as any).listenerCount('drain') || 0;
  });

  return snap;
}

/** Write a memory snapshot to the debug log. No-op when debug disabled. */
export function dbgMemSnapshot(opts: { ctx?: any; trigger?: string; seq?: number } = {}): void {
  if (!enabled) return;
  const snap = captureMemSnapshot(opts);
  writeEvent(snap as unknown as Record<string, unknown>);
}

/** Heap snapshot via v8 inspector — heavy (synchronous, multi-GB) but the
 *  smoking gun for "who holds the references". Writes a `.heapsnapshot` file
 *  next to the debug log; user opens it in Chrome DevTools (Memory → Load).
 *
 *  Returns the path on success or null if the inspector binding isn't
 *  available (V8 builds without inspector are rare on Node official builds
 *  but defensive code never crashes the agent).
 */
export function dbgHeapSnapshot(label?: string): string | null {
  if (!enabled || !logPath) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const v8 = require('v8');
    const dir = path.dirname(logPath);
    const name = `${SESSION_ID}-${label || 'snap'}-${Date.now()}.heapsnapshot`;
    const out = path.join(dir, name);
    v8.writeHeapSnapshot(out);
    writeEvent({ type: 'heap_snapshot', path: out, label });
    return out;
  } catch (e: any) {
    writeEvent({ type: 'heap_snapshot_failed', error: e?.message || String(e) });
    return null;
  }
}

// ── Auto memory threshold ──────────────────────────────────────────────────────
// Two automatic triggers for heap snapshots:
//   1) RSS crosses 1 / 2 / 4 / 8 / 12 GB — coarse-grained checkpoints across
//      a long-running session. Lowered from 4GB so smaller leaks are also
//      captured (the user's last hung session topped out at 625MB and got no
//      heap dump at all under the old 4GB floor).
//   2) Heap grew > SPIKE_HEAP_DELTA_BYTES between consecutive tool calls —
//      catches the FAST-leak pattern where a single tool call allocates many
//      hundreds of MB. The user's data showed +209MB heap on a single Edit
//      that was completely opaque to /memstat counters; spike-detection
//      auto-fires a snapshot at that moment so we can attribute the bytes.

const AUTO_HEAP_THRESHOLDS_GB = [1, 2, 4, 8, 12] as const;
const SPIKE_HEAP_DELTA_BYTES = 100 * 1024 * 1024;     // 100MB jump
const SPIKE_RSS_DELTA_BYTES  = 100 * 1024 * 1024;     // 100MB jump
const triggeredAuto = new Set<number>();
let lastHeapUsed = 0;
let lastRss = 0;
let spikeSnapshotsFired = 0;
const SPIKE_SNAPSHOT_LIMIT = 5;  // cap so we don't write 100 heap dumps in a row

/** Call after every tool result. Cheap RSS check; only fires the heavy
 *  heap-snapshot when crossing an unseen threshold OR when heap/rss spiked
 *  by > 100MB since the previous tool call. */
export function dbgMaybeAutoSnapshot(opts: { ctx?: any; seq?: number } = {}): void {
  if (!enabled) return;
  const mem = process.memoryUsage();
  const rssGB = mem.rss / (1024 ** 3);
  // 1) Coarse threshold crossings
  for (const t of AUTO_HEAP_THRESHOLDS_GB) {
    if (rssGB >= t && !triggeredAuto.has(t)) {
      triggeredAuto.add(t);
      writeEvent({ type: 'auto_heap_threshold_crossed', thresholdGB: t, rssGB });
      dbgMemSnapshot({ ctx: opts.ctx, trigger: `auto_${t}gb`, seq: opts.seq });
      dbgHeapSnapshot(`auto-${t}gb`);
    }
  }
  // 2) Spike detection — ONE tool-call jump > 100MB heap or rss
  if (lastHeapUsed > 0 && spikeSnapshotsFired < SPIKE_SNAPSHOT_LIMIT) {
    const heapDelta = mem.heapUsed - lastHeapUsed;
    const rssDelta = mem.rss - lastRss;
    if (heapDelta > SPIKE_HEAP_DELTA_BYTES || rssDelta > SPIKE_RSS_DELTA_BYTES) {
      spikeSnapshotsFired++;
      writeEvent({
        type: 'auto_heap_spike',
        heapDeltaMB: Math.round(heapDelta / 1048576),
        rssDeltaMB: Math.round(rssDelta / 1048576),
        seq: opts.seq,
        spikeSnapshotsFired,
      });
      dbgMemSnapshot({ ctx: opts.ctx, trigger: `spike_${Math.round(heapDelta / 1048576)}MB`, seq: opts.seq });
      dbgHeapSnapshot(`spike-seq${opts.seq || '?'}`);
    }
  }
  lastHeapUsed = mem.heapUsed;
  lastRss = mem.rss;
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

export function closeDebugLog(): void {
  if (!enabled) return;
  writeEvent({ type: 'session_end', sessionId: SESSION_ID });
  if (fd !== null) {
    try { fs.closeSync(fd); } catch (err) { logger.warn({ err }, 'close debug log failed'); }
    fd = null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sanitizeInput(toolName: string, input: unknown): unknown {
  if (typeof input !== 'object' || input === null) return input;
  const obj = input as Record<string, unknown>;
  // Truncate large content fields so log stays scannable
  const LARGE_FIELDS = ['content', 'new_string', 'old_string'];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (LARGE_FIELDS.includes(k) && typeof v === 'string' && v.length > 300) {
      out[k] = v.slice(0, 300) + `…[${v.length - 300} more chars]`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ── Read / list / tail / follow (Phase 10) ────────────────────────────────────

/**
 * One parsed entry from a debug log file. Mirrors what writeEvent persists:
 * `{ ts, type, ...payload }`. We surface ts/type/sessionId at the top and
 * collapse the rest under `payload` so consumers (UI table) can render
 * without knowing every shape.
 */
export interface DebugLogEntry {
  ts: string;
  type: string;
  sessionId: string;
  payload: Record<string, unknown>;
}

export interface DebugLogSession {
  sessionId: string;
  path: string;
  startedAt: string;     // ISO — derived from the first event's ts when readable, else stat.birthtime
  sizeBytes: number;
  eventCount: number;    // 0 when withCounts is false (avoids reading the whole file)
  isCurrent: boolean;
}

function debugDir(): string {
  return path.join(os.homedir(), '.makestudio', 'debug');
}

function sessionIdFromFile(file: string): string {
  return file.replace(/\.jsonl$/, '');
}

/**
 * Enumerate sessions persisted in `~/.makestudio/debug/`. Cheap by default
 * (stat only); pass `withCounts: true` to also count lines per file (one
 * full read per file — opt in only when the UI needs it).
 */
export function listDebugSessions(opts: { withCounts?: boolean } = {}): DebugLogSession[] {
  const dir = debugDir();
  if (!fs.existsSync(dir)) return [];
  let entries: string[] = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const out: DebugLogSession[] = [];
  for (const file of entries) {
    if (!file.endsWith('.jsonl')) continue;
    const full = path.join(dir, file);
    let stat: fs.Stats;
    try { stat = fs.statSync(full); } catch { continue; }
    let startedAt = stat.birthtime?.toISOString?.() ?? stat.mtime.toISOString();
    let eventCount = 0;
    if (opts.withCounts) {
      try {
        const raw = fs.readFileSync(full, 'utf8');
        // Count non-empty lines. RegEx is fastest for big files.
        eventCount = raw ? (raw.match(/\n/g)?.length ?? 0) + (raw.endsWith('\n') ? 0 : 1) : 0;
        // Try to derive a more accurate startedAt from the first parseable line.
        const firstLine = raw.slice(0, 1024).split('\n').find((l) => l.trim());
        if (firstLine) {
          try {
            const parsed = JSON.parse(firstLine);
            if (typeof parsed?.ts === 'string') startedAt = parsed.ts;
          } catch (err) { swallow(err); }
        }
      } catch (err) { swallow(err); }
    }
    out.push({
      sessionId: sessionIdFromFile(file),
      path: full,
      startedAt,
      sizeBytes: stat.size,
      eventCount,
      isCurrent: full === logPath,
    });
  }
  // Newest first.
  out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return out;
}

function parseLogFile(file: string, sessionId: string): DebugLogEntry[] {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out: DebugLogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const ts = typeof obj.ts === 'string' ? obj.ts : '';
      const type = typeof obj.type === 'string' ? obj.type : 'unknown';
      const payload: Record<string, unknown> = { ...obj };
      delete payload.ts;
      delete payload.type;
      out.push({ ts, type, sessionId, payload });
    } catch (err) { swallow(err); }
  }
  return out;
}

function applyTailFilter(
  entries: DebugLogEntry[],
  opts: { types?: string[]; search?: string; since?: string; limit?: number },
): DebugLogEntry[] {
  let result = entries;
  if (opts.types && opts.types.length > 0) {
    const set = new Set(opts.types);
    result = result.filter((e) => set.has(e.type));
  }
  if (opts.since) {
    result = result.filter((e) => e.ts >= opts.since!);
  }
  if (opts.search && opts.search.trim()) {
    const needle = opts.search.toLowerCase();
    result = result.filter((e) =>
      e.type.toLowerCase().includes(needle) ||
      JSON.stringify(e.payload).toLowerCase().includes(needle),
    );
  }
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000);
  return result.length > limit ? result.slice(result.length - limit) : result;
}

/**
 * Tail a debug log session. Defaults to the current session when no
 * sessionId is provided. Caps at 5000 entries returned to keep IPC
 * payloads bounded — the UI requests larger windows by clicking
 * "load more" with a `since` cursor.
 */
export function tailDebugLog(opts: {
  sessionId?: string;
  limit?: number;
  types?: string[];
  search?: string;
  since?: string;
} = {}): DebugLogEntry[] {
  const dir = debugDir();
  const sessionId = opts.sessionId ?? SESSION_ID;
  const file = path.join(dir, `${sessionId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  const entries = parseLogFile(file, sessionId);
  return applyTailFilter(entries, opts);
}

/**
 * Subscribe to new log entries on a session. Polls the file size at 250ms
 * intervals — `fs.watch` is unreliable on macOS for append-only files and
 * not all linux distros emit `change` for append. Returns an unsubscribe.
 *
 * Caller is responsible for cleanup when their context dies (e.g. the
 * Electron renderer window closes). We do NOT hold onto file descriptors
 * — each poll opens/reads/closes so log rotation doesn't trap us.
 */
export function followDebugLog(
  opts: { sessionId?: string; types?: string[] },
  onLine: (entry: DebugLogEntry) => void,
): () => void {
  const sessionId = opts.sessionId ?? SESSION_ID;
  const file = path.join(debugDir(), `${sessionId}.jsonl`);
  let lastSize = 0;
  try { lastSize = fs.existsSync(file) ? fs.statSync(file).size : 0; } catch (err) { swallow(err); }

  const typeSet = opts.types && opts.types.length > 0 ? new Set(opts.types) : null;
  let cancelled = false;

  const poll = (): void => {
    if (cancelled) return;
    let size = 0;
    try { size = fs.existsSync(file) ? fs.statSync(file).size : 0; } catch { return; }
    if (size === lastSize) return;
    if (size < lastSize) {
      // File rotated/truncated — restart from the new beginning.
      lastSize = 0;
    }
    let chunk = '';
    try {
      const fdRead = fs.openSync(file, 'r');
      try {
        const need = size - lastSize;
        const buf = Buffer.alloc(need);
        fs.readSync(fdRead, buf, 0, need, lastSize);
        chunk = buf.toString('utf8');
      } finally { fs.closeSync(fdRead); }
    } catch { return; }
    lastSize = size;
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const type = typeof obj.type === 'string' ? obj.type : 'unknown';
        if (typeSet && !typeSet.has(type)) continue;
        const ts = typeof obj.ts === 'string' ? obj.ts : '';
        const payload: Record<string, unknown> = { ...obj };
        delete payload.ts;
        delete payload.type;
        onLine({ ts, type, sessionId, payload });
      } catch (err) { swallow(err); }
    }
  };

  const timer = setInterval(poll, 250);
  // Don't keep the process alive just for tailing — Electron main is
  // already pinned by the BrowserWindow, and a CLI scenario shouldn't
  // hold the event loop on a poll.
  timer.unref?.();

  return (): void => {
    cancelled = true;
    clearInterval(timer);
  };
}
