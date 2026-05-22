/**
 * cassettes.ts
 *
 * User-facing session recording/replay. Not a 1:1 port of Claude Code's
 * services/vcr.ts — that file is an HTTP-response cache for unit tests.
 * We deliver the feature I described to the user: a portable, shareable
 * cassette of a single session you can replay (or send for bug reports).
 *
 * Cassettes live at ~/.makestudio/cassettes/<name>.json and are a
 * self-contained superset of our JSONL sessions — easier to pass around.
 *
 * Replay semantic: load cassette → hydrate ctx.messages → the user sees
 * the full prior transcript as if they had resumed. (Deterministic
 * provider-stubbed replay is a follow-up; this MVP covers the sharing
 * use case end-to-end.)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ChatMessage, ReplContext } from './context';

export interface CassetteTurn {
  at: string;            // ISO timestamp
  role: 'user' | 'assistant';
  content: string;
}

export interface Cassette {
  version: 1;
  name: string;
  recordedAt: string;    // ISO start
  stoppedAt?: string;    // ISO end (absent if still recording)
  cwd: string;
  provider?: string;
  model?: string;
  turns: CassetteTurn[];
}

function cassettesDir(): string {
  const d = path.join(os.homedir(), '.makestudio', 'cassettes');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function cassettePath(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80);
  return path.join(cassettesDir(), `${safe}.json`);
}

// ── In-memory recording state (per ReplContext) ─────────────────────────
// Using a WeakMap avoids polluting ctx with a transient field and GCs
// cleanly when the context dies.

interface RecordingState {
  name: string;
  startedAt: string;
  turns: CassetteTurn[];
}

const recordingState: WeakMap<ReplContext, RecordingState> = new WeakMap();

export function isRecording(ctx: ReplContext): boolean {
  return recordingState.has(ctx);
}

export function recordingStatus(ctx: ReplContext): { active: boolean; name?: string; turns?: number; startedAt?: string } {
  const s = recordingState.get(ctx);
  if (!s) return { active: false };
  return { active: true, name: s.name, turns: s.turns.length, startedAt: s.startedAt };
}

/** Start a new recording. Throws if one is already active on this ctx. */
export function startRecording(ctx: ReplContext, name: string): void {
  if (recordingState.has(ctx)) {
    throw new Error(`Already recording "${recordingState.get(ctx)!.name}". Call /record stop first.`);
  }
  recordingState.set(ctx, {
    name,
    startedAt: new Date().toISOString(),
    turns: [],
  });
}

/**
 * Append a turn to the active recording (no-op if not recording).
 * Call this from chat.ts on every user/assistant message finalisation.
 */
export function recordTurn(ctx: ReplContext, msg: ChatMessage): void {
  const s = recordingState.get(ctx);
  if (!s) return;
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  s.turns.push({
    at: new Date().toISOString(),
    role: msg.role,
    content,
  });
}

/** Finalize recording, flush to disk, return the resulting cassette path. */
export function stopRecording(ctx: ReplContext): string {
  const s = recordingState.get(ctx);
  if (!s) throw new Error('Not recording — /record start <name> first.');
  recordingState.delete(ctx);
  const cassette: Cassette = {
    version: 1,
    name: s.name,
    recordedAt: s.startedAt,
    stoppedAt: new Date().toISOString(),
    cwd: ctx.cwd,
    provider: ctx.providerInfo?.provider,
    model: ctx.providerInfo?.model,
    turns: s.turns,
  };
  const p = cassettePath(s.name);
  fs.writeFileSync(p, JSON.stringify(cassette, null, 2), 'utf8');
  return p;
}

// ── CRUD ────────────────────────────────────────────────────────────────

export function listCassettes(): Array<{ name: string; path: string; recordedAt: string; turns: number; sizeBytes: number }> {
  try {
    return fs.readdirSync(cassettesDir())
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const p = path.join(cassettesDir(), f);
        try {
          const raw = fs.readFileSync(p, 'utf8');
          const c: Cassette = JSON.parse(raw);
          const stat = fs.statSync(p);
          return { name: c.name, path: p, recordedAt: c.recordedAt, turns: c.turns.length, sizeBytes: stat.size };
        } catch {
          return { name: f.replace('.json', ''), path: p, recordedAt: '?', turns: 0, sizeBytes: 0 };
        }
      })
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  } catch { return []; }
}

export function loadCassette(name: string): Cassette | null {
  try {
    const raw = fs.readFileSync(cassettePath(name), 'utf8');
    const c = JSON.parse(raw) as Cassette;
    if (c.version !== 1) return null;
    return c;
  } catch { return null; }
}

/**
 * Hydrate ctx.messages from a cassette — equivalent to resuming the
 * session that produced it, cross-cwd. Returns the turn count on success.
 */
export function replayCassette(ctx: ReplContext, name: string): number {
  const c = loadCassette(name);
  if (!c) throw new Error(`Cassette "${name}" not found.`);
  ctx.messages = c.turns.map(t => ({ role: t.role, content: t.content }));
  return c.turns.length;
}

export function deleteCassette(name: string): boolean {
  try { fs.unlinkSync(cassettePath(name)); return true; } catch { return false; }
}
