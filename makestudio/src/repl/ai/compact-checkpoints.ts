import { swallow } from '../../utils/log';
/**
 * compact-checkpoints.ts — snapshot `ctx.messages` before destructive
 * compaction runs. Lets `/undo-compact` restore when a summarizer produced
 * garbage or the user changed their mind.
 *
 * Storage: `~/.makestudio/compact-checkpoints/<sessionId>/<timestamp>.json`.
 * Format: one file per compaction with the full pre-compact messages array
 * + metadata (reason, which compactor ran, message count before/after).
 *
 * Rotation: keep last MAX_CHECKPOINTS_PER_SESSION per session; oldest
 * evicted FIFO. Per-session cap is small on purpose — a compaction is
 * expensive, rerunning one is usually the right answer, and we don't
 * want checkpoint files to grow unbounded.
 *
 * This module is deliberately separate from compact-grouping / chat.ts so
 * the compactor code stays focused on its logic — checkpointing is purely
 * an observational side-effect.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const MAX_CHECKPOINTS_PER_SESSION = 5;

export interface CheckpointMeta {
  /** ISO timestamp of when the snapshot was taken. */
  at: string;
  /** Which compactor ran: 'snip' | 'micro' | 'apiMicro' | 'summary'. */
  reason: string;
  /** Message count before the compaction. */
  beforeCount: number;
  /** Approximate char size of messages before. */
  beforeSizeChars: number;
  /** Session id at the time of snapshot, if known. */
  sessionId?: string;
  /** Working dir — pinned for accurate per-cwd routing on restore. */
  cwd?: string;
}

export interface Checkpoint {
  meta: CheckpointMeta;
  messages: any[];
  /** Path the checkpoint was written to. */
  file: string;
}

function checkpointsRoot(): string {
  const d = path.join(os.homedir(), '.makestudio', 'compact-checkpoints');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function sessionDir(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'default';
  const d = path.join(checkpointsRoot(), safe);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function estimateSize(messages: any[]): number {
  try {
    return messages.reduce((s, m) => s + JSON.stringify(m).length, 0);
  } catch { return 0; }
}

/**
 * Snapshot the current ctx.messages before a compactor runs. Returns the
 * path written to (or null if snapshotting is disabled via settings).
 * Non-blocking on failure — a broken disk shouldn't crash the REPL.
 */
export function snapshotBeforeCompact(
  ctx: any,
  reason: 'snip' | 'micro' | 'apiMicro' | 'summary',
): string | null {
  // Respect settings.compactCheckpointsDisabled when defined.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    if (require('../settings').loadSettings().compactCheckpointsDisabled) return null;
  } catch (err) { swallow(err); }
  try {
    const sessionId: string = (ctx as any).sessionId || 'ephemeral';
    const dir = sessionDir(sessionId);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `${timestamp}-${reason}.json`);
    const meta: CheckpointMeta = {
      at: new Date().toISOString(),
      reason,
      beforeCount: (ctx.messages || []).length,
      beforeSizeChars: estimateSize(ctx.messages || []),
      sessionId,
      cwd: ctx.cwd,
    };
    const body = { meta, messages: ctx.messages || [] };
    fs.writeFileSync(file, JSON.stringify(body));
    rotateCheckpoints(dir);
    return file;
  } catch { return null; }
}

function rotateCheckpoints(dir: string): void {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ f, at: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => a.at - b.at); // oldest first
    const excess = files.length - MAX_CHECKPOINTS_PER_SESSION;
    for (let i = 0; i < excess; i++) {
      try { fs.unlinkSync(path.join(dir, files[i].f)); } catch (err) { swallow(err); }
    }
  } catch (err) { swallow(err); }
}

/**
 * List checkpoints for a given session, newest first. If sessionId is
 * omitted, merges checkpoints from every session dir (useful for
 * /undo-compact when the current session id isn't known).
 */
export function listCheckpoints(sessionId?: string): Checkpoint[] {
  const out: Checkpoint[] = [];
  const walk = (dir: string) => {
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      for (const f of files) {
        const full = path.join(dir, f);
        try {
          const body = JSON.parse(fs.readFileSync(full, 'utf8'));
          if (body && body.meta && Array.isArray(body.messages)) {
            out.push({ meta: body.meta, messages: body.messages, file: full });
          }
        } catch (err) { swallow(err); }
      }
    } catch (err) { swallow(err); }
  };
  if (sessionId) {
    walk(sessionDir(sessionId));
  } else {
    try {
      for (const d of fs.readdirSync(checkpointsRoot())) {
        walk(path.join(checkpointsRoot(), d));
      }
    } catch (err) { swallow(err); }
  }
  return out.sort((a, b) => (b.meta.at.localeCompare(a.meta.at)));
}

/**
 * Restore the most recent (or index-th) checkpoint into ctx.messages.
 * Returns { restored, reason } — `restored=false` means no checkpoint
 * was found. The snapshot file IS consumed (removed) on success so
 * repeated /undo-compact walks backward. Callers should log the result.
 */
export function restoreCheckpoint(
  ctx: any,
  index: number = 0,
  sessionId?: string,
): { restored: boolean; reason?: string; from?: CheckpointMeta } {
  const sid = sessionId || (ctx as any).sessionId || 'ephemeral';
  const list = listCheckpoints(sid);
  if (list.length === 0) return { restored: false, reason: 'no checkpoints for this session' };
  if (index < 0 || index >= list.length) {
    return { restored: false, reason: `index ${index} out of range (have ${list.length})` };
  }
  const pick = list[index];
  try {
    ctx.messages = pick.messages;
    try { fs.unlinkSync(pick.file); } catch (err) { swallow(err); }
    return { restored: true, from: pick.meta };
  } catch (e: any) {
    return { restored: false, reason: e.message || String(e) };
  }
}

/** Wipe checkpoints for a session. Used by /clear. */
export function clearCheckpoints(sessionId?: string): number {
  let count = 0;
  const wipe = (dir: string) => {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.json')) {
          try { fs.unlinkSync(path.join(dir, f)); count++; } catch (err) { swallow(err); }
        }
      }
    } catch (err) { swallow(err); }
  };
  if (sessionId) wipe(sessionDir(sessionId));
  else {
    try {
      for (const d of fs.readdirSync(checkpointsRoot())) wipe(path.join(checkpointsRoot(), d));
    } catch (err) { swallow(err); }
  }
  return count;
}
