import { swallow } from '../utils/log';
/**
 * file-history.ts
 *
 * Snapshot-on-edit / undo. Ported semantic from Claude Code's
 * utils/fileHistory.ts (1115 lines of per-message snapshots + hardlink
 * storage + rewind-over-N-messages); we keep the essence but simplified
 * to a per-file ring buffer:
 *
 *   - Before Write/Edit/MultiEdit actually writes, we snapshot the
 *     current content to ~/.makestudio/file-history/<cwd-slug>/<enc>/<ts>.bak
 *   - MAX_SNAPSHOTS_PER_FILE entries kept per file; oldest evicted FIFO
 *   - /undo-file <path>  restores the most recent snapshot
 *   - /history-file <path>  lists snapshots with age + size
 *
 * We deliberately don't do the hardlink dedup trick Claude Code uses —
 * our files are small and disk is cheap; correctness beats 20% storage.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

export const MAX_SNAPSHOTS_PER_FILE = 20;

// Monotonic suffix counter so snapshots taken within the same millisecond
// don't collide on disk (timestamp prefix alone is not unique enough).
let snapshotSeq = 0;
function nextSnapshotId(): string {
  snapshotSeq = (snapshotSeq + 1) % 1_000_000;
  return snapshotSeq.toString(36).padStart(4, '0');
}

function historyRoot(): string {
  const d = path.join(os.homedir(), '.makestudio', 'file-history');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Path-encode: hash + last 40 chars for human readability. Stable per absolute path. */
function encodeFileKey(absPath: string): string {
  const h = crypto.createHash('sha1').update(absPath).digest('hex').slice(0, 8);
  const tail = absPath.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-40);
  return `${h}-${tail}`;
}

function fileHistoryDir(cwd: string, absPath: string): string {
  const cwdSlug = cwd.replace(/^\//, '').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80);
  const d = path.join(historyRoot(), cwdSlug, encodeFileKey(absPath));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function listSnapshotFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.bak'))
      .sort(); // timestamp prefix = lexicographic sort works
  } catch { return []; }
}

function evictOldest(dir: string, keep: number): number {
  const snaps = listSnapshotFiles(dir);
  if (snaps.length <= keep) return 0;
  const toDelete = snaps.slice(0, snaps.length - keep);
  let deleted = 0;
  for (const f of toDelete) {
    try { fs.unlinkSync(path.join(dir, f)); deleted++; } catch (err) { swallow(err); }
  }
  return deleted;
}

export interface SnapshotInfo {
  file: string;        // snapshot filename
  fullPath: string;    // absolute path of snapshot on disk
  createdAt: Date;
  sizeBytes: number;
}

/**
 * Capture a snapshot of `absPath` (if it exists) BEFORE a destructive edit.
 * When the file doesn't exist yet (a fresh Write), records a null marker so
 * undo can delete the freshly-created file. Returns the snapshot record, or
 * null when disabled / path invalid.
 */
export function snapshotBeforeEdit(cwd: string, absPath: string): SnapshotInfo | null {
  if (!path.isAbsolute(absPath)) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    if (require('./settings').loadSettings().fileHistoryDisabled) return null;
  } catch (err) { swallow(err); }

  const dir = fileHistoryDir(cwd, absPath);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const seq = nextSnapshotId();
  let snapFile: string;
  let sizeBytes = 0;
  if (fs.existsSync(absPath)) {
    const buf = fs.readFileSync(absPath);
    // Dedup: if the latest snapshot has the same size AND content, skip —
    // the file was "edited" but the on-disk bytes didn't change (idempotent
    // replace, formatter roundtrip, etc.). Port of Claude Code's
    // checkOriginFileChanged in fileHistory.ts:258-268.
    const latest = listSnapshotFiles(dir).slice(-1)[0];
    if (latest) {
      try {
        const latestPath = path.join(dir, latest);
        const latestBuf = fs.readFileSync(latestPath);
        if (latestBuf.length === buf.length && latestBuf.equals(buf)) {
          return {
            file: latest,
            fullPath: latestPath,
            createdAt: fs.statSync(latestPath).mtime,
            sizeBytes: latestBuf.length,
          };
        }
      } catch (err) { swallow(err); }
    }
    snapFile = `${ts}-${seq}.bak`;
    fs.writeFileSync(path.join(dir, snapFile), buf);
    sizeBytes = buf.length;
  } else {
    // Marker: file didn't exist → restore means deleting whatever the edit wrote.
    snapFile = `${ts}-${seq}.deleted.bak`;
    fs.writeFileSync(path.join(dir, snapFile), '', 'utf8');
  }
  evictOldest(dir, MAX_SNAPSHOTS_PER_FILE);
  return {
    file: snapFile,
    fullPath: path.join(dir, snapFile),
    createdAt: new Date(),
    sizeBytes,
  };
}

export function listFileHistory(cwd: string, absPath: string): SnapshotInfo[] {
  const dir = fileHistoryDir(cwd, absPath);
  return listSnapshotFiles(dir).map(f => {
    const full = path.join(dir, f);
    let stat: fs.Stats | null = null;
    try { stat = fs.statSync(full); } catch (err) { swallow(err); }
    return {
      file: f,
      fullPath: full,
      createdAt: stat ? stat.mtime : new Date(0),
      sizeBytes: stat ? stat.size : 0,
    };
  });
}

export interface RestoreResult {
  restored: boolean;
  reason?: string;
  from?: string;
  deleted?: boolean; // true if the restore removed the file (snapshot was a deleted marker)
}

/**
 * Restore a file from its most recent snapshot. When `index` is passed (0 =
 * newest, 1 = next, etc.) picks that one instead. After a successful restore
 * the snapshot is consumed (removed from history) so repeated /undo walks back.
 */
export function restoreFile(cwd: string, absPath: string, index: number = 0): RestoreResult {
  if (!path.isAbsolute(absPath)) return { restored: false, reason: 'path must be absolute' };
  const snaps = listFileHistory(cwd, absPath);
  if (snaps.length === 0) return { restored: false, reason: 'no snapshots' };
  const pick = snaps[snaps.length - 1 - index]; // newest first (list is oldest→newest)
  if (!pick) return { restored: false, reason: `index ${index} out of range (have ${snaps.length})` };

  try {
    if (pick.file.includes('.deleted.')) {
      try { fs.unlinkSync(absPath); } catch (err) { swallow(err); }
      fs.unlinkSync(pick.fullPath);
      return { restored: true, from: pick.file, deleted: true };
    }
    const buf = fs.readFileSync(pick.fullPath);
    fs.writeFileSync(absPath, buf);
    fs.unlinkSync(pick.fullPath);
    return { restored: true, from: pick.file };
  } catch (e: any) {
    return { restored: false, reason: e?.message || String(e) };
  }
}

/** Wipe all file-history entries under the given cwd. Used by tests + /clear. */
export function clearFileHistory(cwd: string): void {
  const cwdSlug = cwd.replace(/^\//, '').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80);
  const dir = path.join(historyRoot(), cwdSlug);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { swallow(err); }
}
