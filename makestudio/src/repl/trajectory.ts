import { swallow } from '../utils/log';
/**
 * trajectory.ts — append-only event log for replay / debug / repro.
 *
 * Inspired by openclaw's `src/trajectory/` module (paths.ts + runtime.ts +
 * export.ts, ~1200 lines). Simpler port: one JSONL per session under
 * `~/.makestudio/trajectory/<session-id>.jsonl`, no pointer file, no
 * queued writer (synchronous append — overhead is negligible for our
 * event rate), no separate process/recorder lifecycle.
 *
 * Event types emitted (callers in chat.ts + tools.ts):
 *   - llm_request_start / llm_request_end / llm_request_error
 *   - tool_call_start    / tool_call_end    / tool_call_error
 *   - turn_start         / turn_end
 *   - compaction
 *   - skill_invoke
 *   - permission_decision
 *
 * Each event includes `seq` (monotonic per session), `ts` (ISO8601),
 * `sessionId`, optional `parentSeq` (for tool calls inside a turn), and
 * arbitrary JSON `data`. All writes are best-effort — trajectory failure
 * never breaks the chat path.
 *
 * Why ship: post-mortem on a stuck run ("why did the agent loop on
 * Grep?"), shareable repros (zip the trajectory + send to teammate),
 * and a foundation for `/replay` later (same trajectory, different
 * model).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const TRAJECTORY_DIR = path.join(os.homedir(), '.makestudio', 'trajectory');
/** Per-event line size cap. Big tool outputs / model responses get
 *  summarised in the event payload — full body lives in the session
 *  JSONL anyway. */
const MAX_EVENT_BYTES = 256 * 1024;
/** Keep this in sync with the documented schema in /trajectory show. */
const TRAJECTORY_SCHEMA_VERSION = 1 as const;

export interface TrajectoryEvent {
  schema: 'makestudio-trajectory';
  schemaVersion: typeof TRAJECTORY_SCHEMA_VERSION;
  /** Monotonic per session, starts at 1. */
  seq: number;
  /** ISO8601. */
  ts: string;
  sessionId: string;
  /** Lifecycle slot — broad bucket so post-hoc filters work without
   *  knowing every type. */
  source: 'runtime' | 'tool' | 'model' | 'user';
  /** Free-form event type. Callers pick. Examples below. */
  type: string;
  /** seq of the parent event when this is a child (e.g. tool_call_end
   *  references the seq of its tool_call_start). */
  parentSeq?: number;
  /** Free-form payload. Sanitised at the boundary — no fs paths
   *  outside cwd, no env tokens, no auth headers. */
  data?: Record<string, unknown>;
}

interface SessionState {
  seq: number;
  filePath: string;
}

const sessions = new Map<string, SessionState>();

function ensureDir(): void {
  try { fs.mkdirSync(TRAJECTORY_DIR, { recursive: true }); } catch (err) { swallow(err); }
}

function safeSessionFileName(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
  return /[A-Za-z0-9]/.test(safe) ? safe : 'session';
}

function getOrInitSession(sessionId: string): SessionState {
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  ensureDir();
  const filePath = path.join(TRAJECTORY_DIR, `${safeSessionFileName(sessionId)}.jsonl`);
  // If the file already exists (resumed session), continue numbering
  // from the highest seq we find. Avoids clobbering on -c.
  let nextSeq = 1;
  try {
    const existingContent = fs.readFileSync(filePath, 'utf8');
    const lines = existingContent.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (typeof obj?.seq === 'number') {
          nextSeq = obj.seq + 1;
          break;
        }
      } catch (err) { swallow(err); }
    }
  } catch (err) { swallow(err); }
  const state: SessionState = { seq: nextSeq, filePath };
  sessions.set(sessionId, state);
  return state;
}

/**
 * Strip values that obviously shouldn't end up in a shared trajectory.
 * Conservative — drops anything that looks like a token/secret/password
 * by name, plus any string that looks like a JWT or long bearer token.
 * The full session JSONL has the real values; the trajectory is what
 * the user might `/trajectory export` to a teammate.
 */
function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated:depth]';
  if (value == null) return value;
  if (typeof value === 'string') {
    // Long bearer-tokenish string → mask. Keeps short strings intact.
    if (value.length > 80 && /^[A-Za-z0-9._\-+/=]+$/.test(value)) {
      return `[redacted:${value.length}chars]`;
    }
    return value.length > 4096 ? value.slice(0, 4096) + '…[truncated]' : value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (/^(token|secret|password|api[_-]?key|bearer|authorization)$/i.test(k)) {
      out[k] = '[redacted]';
      continue;
    }
    out[k] = sanitize(v, depth + 1);
  }
  return out;
}

/**
 * Append a trajectory event for the given session. Best-effort —
 * write failure / disk full / permission errors all swallowed. Returns
 * the seq assigned to the event so callers can pass it as parentSeq
 * later (e.g. tool_call_end references the seq of tool_call_start).
 */
export function recordTrajectoryEvent(
  sessionId: string,
  source: TrajectoryEvent['source'],
  type: string,
  data?: Record<string, unknown>,
  parentSeq?: number,
): number | null {
  if (!sessionId) return null;
  // Allow opt-out via env var, mirroring openclaw.
  if (process.env.MAKESTUDIO_TRAJECTORY === '0') return null;
  let state: SessionState;
  try { state = getOrInitSession(sessionId); } catch { return null; }
  const event: TrajectoryEvent = {
    schema: 'makestudio-trajectory',
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    seq: state.seq,
    ts: new Date().toISOString(),
    sessionId,
    source,
    type,
    parentSeq,
    data: data ? (sanitize(data) as Record<string, unknown>) : undefined,
  };
  let line: string;
  try { line = JSON.stringify(event); } catch { return null; }
  if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES) {
    // Replace data with a stub so the seq is still in the timeline.
    const stub: TrajectoryEvent = {
      ...event,
      data: { truncated: true, originalBytes: Buffer.byteLength(line, 'utf8') },
    };
    try { line = JSON.stringify(stub); } catch { return null; }
  }
  try {
    fs.appendFileSync(state.filePath, line + '\n', 'utf8');
  } catch { return null; }
  state.seq += 1;
  return event.seq;
}

/**
 * List trajectories present on disk. Caller can filter by sessionId,
 * print summaries, or feed into export/replay.
 */
export function listTrajectories(): Array<{
  sessionId: string;
  filePath: string;
  bytes: number;
  events: number;
  startedAt?: string;
  lastEventAt?: string;
}> {
  ensureDir();
  let entries: string[];
  try { entries = fs.readdirSync(TRAJECTORY_DIR); } catch { return []; }
  const out: ReturnType<typeof listTrajectories> = [];
  for (const e of entries) {
    if (!e.endsWith('.jsonl')) continue;
    const filePath = path.join(TRAJECTORY_DIR, e);
    try {
      const stat = fs.statSync(filePath);
      const text = fs.readFileSync(filePath, 'utf8');
      const lines = text.split('\n').filter(Boolean);
      let firstTs: string | undefined;
      let lastTs: string | undefined;
      let sessionId = e.replace(/\.jsonl$/, '');
      try {
        if (lines[0]) {
          const first = JSON.parse(lines[0]);
          firstTs = first?.ts;
          if (first?.sessionId) sessionId = first.sessionId;
        }
        if (lines[lines.length - 1]) {
          const last = JSON.parse(lines[lines.length - 1]);
          lastTs = last?.ts;
        }
      } catch (err) { swallow(err); }
      out.push({
        sessionId,
        filePath,
        bytes: stat.size,
        events: lines.length,
        startedAt: firstTs,
        lastEventAt: lastTs,
      });
    } catch (err) { swallow(err); }
  }
  // Most recent last-event first.
  out.sort((a, b) => (b.lastEventAt || '').localeCompare(a.lastEventAt || ''));
  return out;
}

/**
 * Read all events for a session. Returns null when the trajectory
 * file doesn't exist. Caller renders / filters as needed.
 */
export function readTrajectory(sessionId: string): TrajectoryEvent[] | null {
  ensureDir();
  const filePath = path.join(TRAJECTORY_DIR, `${safeSessionFileName(sessionId)}.jsonl`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const events: TrajectoryEvent[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj?.schema === 'makestudio-trajectory') events.push(obj as TrajectoryEvent);
      } catch (err) { swallow(err); }
    }
    return events;
  } catch { return null; }
}

/**
 * Build a portable bundle (a JSON manifest + the raw JSONL) for
 * sharing a repro. Returns the bundle path. The user can attach
 * the file to an issue / send it to a teammate / feed it back into
 * makestudio for replay (future feature).
 *
 * Bundle is a single JSON file rather than a tarball — simpler to
 * inspect, no native deps. Keeps the payload self-contained.
 */
export function exportTrajectoryBundle(sessionId: string, outDir?: string): string | null {
  const events = readTrajectory(sessionId);
  if (!events) return null;
  const manifest = {
    schema: 'makestudio-trajectory-bundle',
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sessionId,
    eventCount: events.length,
    firstEventAt: events[0]?.ts,
    lastEventAt: events[events.length - 1]?.ts,
    events,
  };
  const dir = outDir || process.cwd();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (err) { swallow(err); }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(dir, `trajectory-${safeSessionFileName(sessionId)}-${stamp}.json`);
  try {
    fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2), 'utf8');
    return outPath;
  } catch { return null; }
}

/**
 * Drop a session's trajectory cache (used after `/clear` or session
 * reset). Doesn't delete the file from disk — only clears the in-process
 * seq counter so a fresh session starts at 1 again.
 */
export function resetTrajectorySession(sessionId: string): void {
  sessions.delete(sessionId);
}

/**
 * Pull the active session id off the context. The session id is the
 * basename of the session JSONL file minus extension. Returns empty
 * string when no session is active yet (callers treat that as "skip
 * trajectory recording").
 */
export function getCurrentSessionId(ctx: any): string {
  try {
    const { currentSessionFile } = require('./sessions');
    const f: string | null = currentSessionFile(ctx);
    if (!f) return '';
    const base = path.basename(f);
    return base.replace(/\.jsonl$/, '');
  } catch { return ''; }
}

/** Convenience wrapper: caller passes ctx instead of sessionId. */
export function recordCtxEvent(
  ctx: any,
  source: TrajectoryEvent['source'],
  type: string,
  data?: Record<string, unknown>,
  parentSeq?: number,
): number | null {
  const sessionId = getCurrentSessionId(ctx);
  if (!sessionId) return null;
  return recordTrajectoryEvent(sessionId, source, type, data, parentSeq);
}
