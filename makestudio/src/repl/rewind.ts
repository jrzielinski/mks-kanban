import { swallow } from '../utils/log';
/**
 * rewind.ts — per-turn file snapshots + restore (Fase 2.4).
 *
 * Port of Claude Code's src/commands/rewind (simplified).
 *
 * Every user message starts a new "turn" identified by an incrementing
 * number on ctx (`ctx.currentTurnNum`). When the agent edits a file via
 * Write/Edit/MultiEdit/NotebookEdit, we snapshot the file's PREVIOUS
 * content under `.makestudio/checkpoints/<sessionId>/turn-<N>/files.json`.
 * Each checkpoint remembers (a) the user message that started it,
 * (b) the start time, (c) a list of `{path, prevContent}` deltas.
 *
 * `/rewind <N>` restores the files saved at turn N (so you undo EVERYTHING
 * from turn N onward) and truncates `ctx.messages` down to the pre-turn-N
 * history. `/rewind` lists available turns, `/rewind clear` wipes them.
 *
 * Files that the agent created fresh in turn N are handled by a sentinel:
 * `prevContent` is the exact string `__REWIND_DELETE__` — rewind deletes
 * the file instead of writing old content.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ReplContext } from './context';
import { currentSessionFile } from './sessions';
import { getCurrentSessionId, recordTrajectoryEvent } from './trajectory';

const DELETE_SENTINEL = '__REWIND_DELETE__';

interface CheckpointFile {
  path: string;
  prevContent: string;
}
interface Checkpoint {
  turn: number;
  startedAt: string;
  userMessage: string;
  files: CheckpointFile[];
  /** Length of ctx.messages when this turn STARTED (for truncation on restore). */
  messagesBefore: number;
}

function sessionIdFromCtx(ctx: ReplContext): string | null {
  const f = currentSessionFile(ctx);
  if (!f) return null;
  return path.basename(f, '.jsonl');
}

function checkpointsDir(ctx: ReplContext): string | null {
  const sid = sessionIdFromCtx(ctx);
  if (!sid) return null;
  const dir = path.join(os.homedir(), '.makestudio', 'checkpoints', sid);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function turnDir(ctx: ReplContext, turn: number): string | null {
  const root = checkpointsDir(ctx);
  if (!root) return null;
  return path.join(root, `turn-${String(turn).padStart(4, '0')}`);
}

function metaFile(dir: string): string { return path.join(dir, 'meta.json'); }

/**
 * Begin a new turn. Called from chat.ts runTurn() after the user message
 * is pushed onto ctx.messages. Increments ctx.currentTurnNum and writes
 * an empty meta.json for this turn.
 */
export function beginTurn(ctx: any, userMessage: string): void {
  ctx.currentTurnNum = (ctx.currentTurnNum || 0) + 1;
  const dir = turnDir(ctx, ctx.currentTurnNum);
  if (!dir) return; // no session file yet — nothing to checkpoint against
  fs.mkdirSync(dir, { recursive: true });
  const checkpoint: Checkpoint = {
    turn: ctx.currentTurnNum,
    startedAt: new Date().toISOString(),
    userMessage: userMessage.slice(0, 200),
    files: [],
    // -1 because the user msg was just pushed; we want the index of the
    // last message BEFORE the turn started for accurate truncation.
    messagesBefore: Math.max(0, (ctx.messages?.length || 1) - 1),
  };
  try { fs.writeFileSync(metaFile(dir), JSON.stringify(checkpoint, null, 2) + '\n', 'utf8'); }
  catch (err) { swallow(err); }
}

/**
 * Record that `filePath` was about to change in the current turn. Captures
 * the file's content BEFORE the edit so rewind can restore it. Idempotent
 * within a turn — if we already have a snapshot for this path, keep the
 * oldest (the true "before turn" content).
 */
export function recordFileSnapshot(ctx: any, filePath: string): void {
  const turn = ctx.currentTurnNum;
  if (!turn) return; // no active turn (pre-first-user-msg shouldn't happen)
  const dir = turnDir(ctx, turn);
  if (!dir) return;
  const meta = metaFile(dir);
  let cp: Checkpoint;
  try {
    cp = JSON.parse(fs.readFileSync(meta, 'utf8'));
  } catch { return; /* meta missing or broken — beginTurn didn't run */ }
  if (cp.files.some((f) => f.path === filePath)) return; // already snapped

  const prevContent = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8')
    : DELETE_SENTINEL; // file was created in this turn — rewind deletes it
  cp.files.push({ path: filePath, prevContent });
  try { fs.writeFileSync(meta, JSON.stringify(cp, null, 2) + '\n', 'utf8'); }
  catch (err) { swallow(err); }
}

/** Load every checkpoint for this session, oldest first. */
export function listCheckpoints(ctx: ReplContext): Checkpoint[] {
  const root = checkpointsDir(ctx);
  if (!root || !fs.existsSync(root)) return [];
  const out: Checkpoint[] = [];
  for (const name of fs.readdirSync(root)) {
    if (!name.startsWith('turn-')) continue;
    const meta = path.join(root, name, 'meta.json');
    try { out.push(JSON.parse(fs.readFileSync(meta, 'utf8'))); }
    catch (err) { swallow(err); }
  }
  out.sort((a, b) => a.turn - b.turn);
  return out;
}

/**
 * Restore files to their pre-turn-N state AND truncate ctx.messages to
 * before turn N. Returns counts so the caller can report to the user.
 */
export function rewindToTurn(ctx: any, turn: number): { filesRestored: number; filesDeleted: number; messagesDropped: number; error?: string } {
  const sessionId = getCurrentSessionId(ctx);
  if (sessionId) {
    recordTrajectoryEvent(sessionId, 'runtime', 'rewind_start', { targetTurn: turn, currentTurn: ctx.currentTurnNum });
  }
  const dir = turnDir(ctx, turn);
  if (!dir || !fs.existsSync(dir)) return { filesRestored: 0, filesDeleted: 0, messagesDropped: 0, error: `Turn ${turn} not found.` };
  let cp: Checkpoint;
  try { cp = JSON.parse(fs.readFileSync(metaFile(dir), 'utf8')); }
  catch (err: any) { return { filesRestored: 0, filesDeleted: 0, messagesDropped: 0, error: `Failed to read checkpoint: ${err.message}` }; }

  // Also restore snapshots from ALL turns >= N so we truly rewind to the
  // pre-N state (files touched in later turns need to go back too).
  const all = listCheckpoints(ctx).filter((c) => c.turn >= turn);
  // Apply per-file: oldest snapshot wins (that's the content before the
  // first touch in this rewind window).
  const winningByPath = new Map<string, string>();
  for (const c of all) {
    for (const f of c.files) {
      if (!winningByPath.has(f.path)) winningByPath.set(f.path, f.prevContent);
    }
  }

  let filesRestored = 0, filesDeleted = 0;
  for (const [p, prev] of winningByPath) {
    try {
      if (prev === DELETE_SENTINEL) {
        if (fs.existsSync(p)) { fs.unlinkSync(p); filesDeleted++; }
      } else {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, prev, 'utf8');
        filesRestored++;
      }
    } catch (err) { swallow(err); }
  }

  // Truncate message history to the pre-N point.
  const before = Array.isArray(ctx.messages) ? ctx.messages.length : 0;
  const keep = Math.min(before, cp.messagesBefore);
  const messagesDropped = before - keep;
  if (ctx.messages && ctx.messages.length > keep) {
    ctx.messages.length = keep;
  }
  ctx.currentTurnNum = turn - 1; // next user msg becomes "turn N" again

  return { filesRestored, filesDeleted, messagesDropped };
}

/**
 * Build a per-file diff summary across [fromTurn, toTurn). For each file
 * that was touched, we compare:
 *   - START state: the EARLIEST snapshot in the range (this is the
 *     content right before the file was first edited within the range).
 *     If no snapshot exists, the file was untouched in the range.
 *   - END state: the file's CURRENT content on disk (after all edits in
 *     the range have been applied).
 *
 * Output is structured so a slash handler can render it as a list of
 * unified diffs. The slash handler decides truncation / formatting.
 */
export interface TurnDiffEntry {
  path: string;
  /** 'created' (snapshot was DELETE sentinel), 'deleted' (file gone now,
   *  snapshot existed), or 'modified' (snapshot vs disk both exist). */
  status: 'created' | 'deleted' | 'modified' | 'unchanged';
  /** Pre-range content. Empty string when status='created'. */
  before: string;
  /** Post-range content. Empty string when status='deleted'. */
  after: string;
  /** Turn numbers within the range that touched this file. */
  turns: number[];
}

export function diffTurns(ctx: ReplContext, fromTurn: number, toTurn: number): TurnDiffEntry[] {
  if (fromTurn > toTurn) return [];
  const all = listCheckpoints(ctx).filter((c) => c.turn >= fromTurn && c.turn <= toTurn);
  if (all.length === 0) return [];

  // For each path, collect the earliest snapshot (true before-range
  // state) AND the list of turns that touched it.
  const earliestByPath = new Map<string, { prevContent: string; turns: number[] }>();
  for (const c of all) {
    for (const f of c.files) {
      const existing = earliestByPath.get(f.path);
      if (!existing) {
        earliestByPath.set(f.path, { prevContent: f.prevContent, turns: [c.turn] });
      } else {
        existing.turns.push(c.turn);
      }
    }
  }

  const out: TurnDiffEntry[] = [];
  for (const [p, { prevContent, turns }] of earliestByPath) {
    const before = prevContent === DELETE_SENTINEL ? '' : prevContent;
    let after = '';
    let exists = false;
    try {
      if (fs.existsSync(p)) {
        after = fs.readFileSync(p, 'utf8');
        exists = true;
      }
    } catch (err) { swallow(err); }

    let status: TurnDiffEntry['status'];
    if (prevContent === DELETE_SENTINEL && exists) status = 'created';
    else if (prevContent === DELETE_SENTINEL && !exists) status = 'unchanged'; // never existed, still doesn't
    else if (!exists) status = 'deleted';
    else if (before === after) status = 'unchanged';
    else status = 'modified';

    out.push({ path: p, status, before, after, turns: turns.sort((a, b) => a - b) });
  }
  // Sort: created → modified → deleted → unchanged, then alpha
  const order = { created: 0, modified: 1, deleted: 2, unchanged: 3 } as const;
  out.sort((a, b) => order[a.status] - order[b.status] || a.path.localeCompare(b.path));
  return out;
}

export function clearCheckpoints(ctx: ReplContext): { removed: number } {
  const root = checkpointsDir(ctx);
  if (!root || !fs.existsSync(root)) return { removed: 0 };
  let removed = 0;
  for (const name of fs.readdirSync(root)) {
    try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); removed++; }
    catch (err) { swallow(err); }
  }
  return { removed };
}
