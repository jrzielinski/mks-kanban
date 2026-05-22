import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const DEFAULT_REPLAY_DIR = path.join(os.homedir(), '.makestudio', 'replay');
let REPLAY_DIR = DEFAULT_REPLAY_DIR;

/**
 * Override the directory replays are written to. Intended for tests — the
 * production call path uses the default ~/.makestudio/replay location.
 * Returns the previous value so callers can restore it on teardown.
 */
export function setReplayDir(dir: string): string {
  const prev = REPLAY_DIR;
  REPLAY_DIR = dir;
  return prev;
}

export function getReplayDir(): string {
  return REPLAY_DIR;
}

export interface ReplayEntry {
  ts: number;
  type: string;
  taskId?: string;
  data: Record<string, any>;
}

let currentSessionFile: string | null = null;
let currentSessionId: string | null = null;

export function startReplaySession(sessionId: string): void {
  // End previous session if still active
  if (currentSessionId) {
    endReplaySession();
  }

  if (!fs.existsSync(REPLAY_DIR)) {
    fs.mkdirSync(REPLAY_DIR, { recursive: true });
  }

  currentSessionId = sessionId;
  currentSessionFile = path.join(REPLAY_DIR, `${sessionId}.jsonl`);

  logReplay('session_start', undefined, { sessionId });
}

export function endReplaySession(): void {
  if (currentSessionId) {
    logReplay('session_end', undefined, { sessionId: currentSessionId });
  }
  currentSessionFile = null;
  currentSessionId = null;
}

/**
 * Redact secret-shaped substrings before persisting replay entries to disk.
 * The replay JSONL files are operator-shareable artifacts; without this a
 * task that pushed via `https://x-access-token:TOKEN@github.com/...` or
 * called a curl with `Authorization: Bearer ...` would persist the secret
 * indefinitely on the operator's machine and into any shared bug report.
 */
function redactInPlace(value: any): any {
  if (typeof value === 'string') {
    return value
      .replace(/https:\/\/[^@/\s]+:[^@/\s]+@/g, 'https://[REDACTED]@')
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._\-+/=]{8,}/gi, (m) => m.split(/\s/)[0] + ' [REDACTED]')
      .replace(/\bgh[psour]_[A-Za-z0-9]{16,}/g, '[REDACTED-GH]')
      .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}/g, '[REDACTED-GH]');
  }
  if (Array.isArray(value)) return value.map(redactInPlace);
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactInPlace(v);
    return out;
  }
  return value;
}

export function logReplay(
  type: string,
  taskId?: string,
  data: Record<string, any> = {},
): void {
  if (!currentSessionFile) return;

  const entry: ReplayEntry = {
    ts: Date.now(),
    type,
    taskId,
    data: redactInPlace(data),
  };

  try {
    fs.appendFileSync(currentSessionFile, JSON.stringify(entry) + '\n');
  } catch {
    // Non-critical — don't break execution for logging
  }
}

export function logToolCall(taskId: string, tool: string, file?: string): void {
  logReplay('tool_call', taskId, { tool, file });
}

export function logFileChange(taskId: string, filePath: string, action: string): void {
  logReplay('file_change', taskId, { filePath, action });
}

export function logGitOp(taskId: string, operation: string, detail?: string): void {
  logReplay('git_op', taskId, { operation, detail });
}

export function logCost(taskId: string, costUsd: number, cli: string): void {
  logReplay('cost', taskId, { costUsd, cli });
}

export function logVerify(taskId: string, passed: boolean, output?: string): void {
  logReplay('verify', taskId, { passed, output: output?.substring(0, 500) });
}

export function logRetry(taskId: string, attempt: number, reason: string): void {
  logReplay('retry', taskId, { attempt, reason });
}

export function getReplaySessionFile(): string | null {
  return currentSessionFile;
}

/**
 * Cleanup old replay files (keep last 50).
 */
export function cleanupOldReplays(): void {
  try {
    if (!fs.existsSync(REPLAY_DIR)) return;
    const files = fs.readdirSync(REPLAY_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({
        name: f,
        time: fs.statSync(path.join(REPLAY_DIR, f)).mtime.getTime(),
      }))
      .sort((a, b) => b.time - a.time);

    // Keep last 50, delete the rest
    for (const file of files.slice(50)) {
      fs.unlinkSync(path.join(REPLAY_DIR, file.name));
    }
  } catch {
    // Non-critical
  }
}
