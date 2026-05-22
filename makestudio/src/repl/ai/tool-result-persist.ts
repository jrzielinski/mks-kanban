import { swallow } from '../../utils/log';
/**
 * tool-result-persist.ts — append every tool call's input/output to a
 * per-session JSONL log on disk.
 *
 * Why: in long sessions the in-memory toolCallHistory is capped at 500
 * entries. Once it overflows, older results are lost and you can't run
 * /thinkback or /diff back into the past. Persisting every call gives:
 *   - durable replay surface (load by session id, replay tool list)
 *   - cheap audit trail for "did the model touch file X?"
 *   - foundation for #22 (replay session) and #18 (offline trace ingest)
 *
 * Off by default. Enable via `settings.toolResultPersist: true` or env
 * `MAKESTUDIO_TOOL_PERSIST=1`. When off, persistToolCall() is a no-op.
 *
 * Layout:
 *   ~/.makestudio/tool-results/<sessionId>.jsonl
 *
 * One entry per line. Each entry:
 *   { ts, seq, tool, input, output, ok, durationMs, traceId? }
 *
 * Output is truncated to MAX_OUTPUT_CHARS to keep the file size bounded
 * — full output stays available in the in-memory cache for as long as
 * it lives. The persisted copy is for replay/audit, not for round-trip
 * fidelity.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const MAX_OUTPUT_CHARS = 20_000;
const MAX_INPUT_CHARS = 8_000;

let cachedEnabled: boolean | null = null;

function isEnabled(): boolean {
  if (cachedEnabled !== null) return cachedEnabled;
  const env = (process.env.MAKESTUDIO_TOOL_PERSIST || '').toLowerCase().trim();
  if (env === '1' || env === 'true' || env === 'on') { cachedEnabled = true; return true; }
  if (env === '0' || env === 'false' || env === 'off') { cachedEnabled = false; return false; }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { loadSettings } = require('../settings');
    const s = loadSettings() as any;
    cachedEnabled = !!s?.toolResultPersist;
    return cachedEnabled;
  } catch { cachedEnabled = false; return false; }
}

export function resetToolResultPersistCache(): void { cachedEnabled = null; }

function persistDir(): string {
  const dir = path.join(os.homedir(), '.makestudio', 'tool-results');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolve a stable session id for the persistence file. Prefers the
 * REPL session file basename when available (so the persisted log
 * lines up with `~/.makestudio/sessions/<id>.jsonl`); falls back to
 * a per-process id so detached invocations still get a file.
 */
function sessionId(ctx: any): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { currentSessionFile } = require('../sessions');
    const f = currentSessionFile(ctx);
    if (f) return path.basename(f, '.jsonl');
  } catch (err) { swallow(err); }
  return 'pid-' + process.pid;
}

/**
 * Resolve the persistence file for a session. Always reads `os.homedir()`
 * fresh (so HOME overrides during tests, fork-after-cd, etc. resolve to
 * the right place). The fs.appendFileSync below is synchronous, so the
 * record is on disk before the function returns — no buffer, no flush
 * race, no leftover open handles to track.
 */
function persistFileFor(sid: string): string {
  return path.join(persistDir(), `${sid}.jsonl`);
}

let seqCounter = 0;

export interface ToolCallRecord {
  ts: string;
  seq: number;
  tool: string;
  input: any;
  output: string;
  ok: boolean;
  durationMs: number;
  traceId?: string;
}

function clip(s: any, max: number): any {
  if (typeof s !== 'string') s = JSON.stringify(s);
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... [truncated at ${max} chars]`;
}

export function persistToolCall(
  ctx: any,
  toolName: string,
  toolInput: any,
  output: string,
  ok: boolean,
  durationMs: number,
): void {
  if (!isEnabled()) return;
  try {
    const sid = sessionId(ctx);
    const file = persistFileFor(sid);

    let traceId: string | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { currentTraceId } = require('../telemetry/otel-tracer');
      const tid = currentTraceId();
      if (tid) traceId = tid;
    } catch (err) { swallow(err); }

    const record: ToolCallRecord = {
      ts: new Date().toISOString(),
      seq: ++seqCounter,
      tool: toolName,
      input: clip(toolInput, MAX_INPUT_CHARS),
      output: clip(output, MAX_OUTPUT_CHARS),
      ok,
      durationMs,
      ...(traceId ? { traceId } : {}),
    };
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
  } catch (err) { swallow(err); }
}

/**
 * Read the on-disk record list for a session id. Returns [] if no
 * file exists or it's unreadable. Used by replay/inspect tooling.
 */
export function loadToolCallRecords(sid: string): ToolCallRecord[] {
  try {
    const file = path.join(persistDir(), `${sid}.jsonl`);
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((line) => {
        try { return JSON.parse(line) as ToolCallRecord; }
        catch { return null; }
      })
      .filter((x): x is ToolCallRecord => x !== null);
  } catch { return []; }
}
