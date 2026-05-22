/**
 * File tool — path-utils topic. Extracted from file-tools.ts.
 */
/**
 * file-tools.ts
 *
 * Core file/code tools exposed to the REPL AI: Read, Write, Edit, MultiEdit,
 * Glob, Grep, Bash. Implementations are self-contained — no dependency on any
 * third-party CLI agent — so the REPL can operate as a complete code agent.
 *
 * Safety rails:
 *   - Write requires a prior Read of the same absolute path in-session
 *     (prevents clobbering files the agent hasn't inspected).
 *   - Edit requires old_string to be unique in the file (unless replace_all).
 *   - Bash runs through the session sandbox wrapper, with a hard ceiling on
 *     timeout and a default 2min.
 *   - Paths must be absolute.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import fastGlob from 'fast-glob';
import { ReplContext } from '../../context';
import { ToolDefinition } from '../tools';
import { subprocessEnv } from '../../subprocess-env';

const MAX_READ_LINES = 2000;
const DEFAULT_READ_LINE_WIDTH = 2000;    // chars per line truncation
const MAX_BASH_TIMEOUT_MS = 600_000;     // 10 min hard ceiling
const DEFAULT_BASH_TIMEOUT_MS = 120_000; // 2 min default

// Per-session tracking: set of absolute paths that have been read.
// Write/Edit require the path to be in this set to prevent blind overwrites.
//
// Capped LRU via insertion-order deletion (Set preserves insertion order).
// Stress test #13 flagged the old unbounded Set as a slow leak: long sessions
// reading 1000s of unique files accumulated proportional memory. With the cap,
// the oldest-read path is evicted once we exceed MAX_READ_PATHS_PER_SESSION —
// the only user-visible impact is that a very-long-ago Read no longer
// satisfies the "Read-before-Write" gate, which just forces an extra Read.
const MAX_READ_PATHS_PER_SESSION = 1000;
const readPaths: WeakMap<ReplContext, Set<string>> = new WeakMap();
export function markRead(ctx: ReplContext, abs: string): void {
  let set = readPaths.get(ctx);
  if (!set) { set = new Set(); readPaths.set(ctx, set); }
  // Re-insert to move to the end (LRU refresh). delete+add is cheaper
  // than rebuilding the Set.
  if (set.has(abs)) set.delete(abs);
  set.add(abs);
  if (set.size > MAX_READ_PATHS_PER_SESSION) {
    // Evict oldest. Set iteration is insertion order — first key is the
    // least-recently-read that hasn't been re-touched.
    const oldest = set.values().next().value as string | undefined;
    if (oldest) set.delete(oldest);
  }
}

export function wasRead(ctx: ReplContext, abs: string): boolean {
  return readPaths.get(ctx)?.has(abs) ?? false;
}
export function getReadPaths(ctx: ReplContext): string[] {
  const set = readPaths.get(ctx);
  return set ? [...set] : [];
}

/**
 * Expand a leading `~` (or `~/...`) to the user's home dir. Node's fs APIs
 * treat `~` as a literal directory name — when a model passes `~/develop/foo`
 * the underlying tool runs in a non-existent directory and silently returns
 * 0 matches (Glob) or "ENOENT" (Read). Mirrors what every shell already
 * does. No-op on non-tilde inputs.
 */
export function expandTilde(p: string): string {
  if (!p || typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function requireAbsolute(p: string): void {
  if (!path.isAbsolute(p)) {
    throw new Error(`Path must be absolute. Got: ${p}`);
  }
}

/**
 * Reject paths that point at OS-level pseudo-files which would either
 * hang the read (block devices, named pipes without writers) or expose
 * sensitive runtime state.
 *
 * Linux:
 *   /dev/* — block/char devices, /dev/zero hangs forever, /dev/random
 *            spends entropy, /dev/null is harmless but pointless.
 *   /proc/<pid>/fd/* — file-descriptor passthrough; reading another
 *            process's fd 0/1/2 hangs indefinitely waiting for input
 *            or yields stale stdout.
 *   /sys/*  — kernel-space sysfs; mostly inert reads but a few entries
 *            block (e.g. /sys/kernel/tracing/trace_pipe).
 *
 * Windows:
 *   \\.\ and \\?\ — DOS device namespace (\\.\PhysicalDrive0, \\?\C:\…).
 *                   Reading these requires special handling; treat as
 *                   forbidden in normal Read/Write.
 *   UNC \\server\share — network paths; allow only with explicit opt-in
 *                        (out of scope here).
 *   CON, PRN, AUX, NUL, COM1..9, LPT1..9 — DOS reserved names; on
 *                   Windows, opening these crashes / hangs depending on
 *                   the path syntax. Match case-insensitively against
 *                   the basename without extension.
 *
 * Inspired by claude-code's filesystem.ts:50+ DANGEROUS_DIRS / device
 * detection. Inspired but not ported wholesale — claude-code has more
 * Windows-specific edge cases (NTFS streams, 8.3 names) that we don't
 * support yet on either platform.
 */
const DOS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

export function rejectDevicePath(p: string): void {
  if (!p) return;
  // Linux pseudo-fs prefixes
  if (/^\/dev(\/|$)/.test(p)) {
    throw new Error(`Refusing to access device file ${p} — /dev/* is forbidden (would hang or expose hardware state).`);
  }
  if (/^\/proc\/\d+\/fd(\/|$)/.test(p)) {
    throw new Error(`Refusing to access ${p} — /proc/<pid>/fd/* is forbidden (would hang reading another process's stream).`);
  }
  if (/^\/sys(\/|$)/.test(p)) {
    throw new Error(`Refusing to access ${p} — /sys/* is forbidden (kernel-space pseudo-fs).`);
  }
  // Windows DOS device namespace
  if (/^\\\\[?.]\\/.test(p)) {
    throw new Error(`Refusing to access ${p} — Windows DOS device namespace (\\\\?\\, \\\\.\\) is forbidden.`);
  }
  // DOS reserved names — match basename without extension, case-insensitive
  const base = path.basename(p).split('.')[0].toUpperCase();
  if (DOS_RESERVED_NAMES.has(base)) {
    throw new Error(`Refusing to access ${p} — "${base}" is a reserved DOS device name.`);
  }
}

/**
 * Detect + normalize line endings and BOM from a raw buffer. Returns
 * `{ text, lineEnding, bom }` mirroring Claude Code's
 * `utils/fileRead.ts:readFileSyncWithMetadata`. The returned `text` is
 * always LF-normalized + BOM-stripped so downstream logic can treat it
 * as a plain UTF-8 string; the metadata is cached per-path so subsequent
 * Write/Edit can restore the original encoding on disk (prevents Windows
 * CRLF→LF bloat in git diffs).
 */
export function readFileWithMetadata(filePath: string): {
  text: string;
  lineEnding: 'lf' | 'crlf';
  bom: boolean;
} {
  return decodeBuffer(fs.readFileSync(filePath));
}

/**
 * Async variant of readFileWithMetadata. Use this in any tool whose
 * call sites are already async — file I/O is the slowest synchronous
 * operation an agent does on a turn, and blocking the event loop for
 * tens of MB of bytes prevents Esc-cancel from interrupting it.
 */
export async function readFileWithMetadataAsync(filePath: string): Promise<{
  text: string;
  lineEnding: 'lf' | 'crlf';
  bom: boolean;
}> {
  return decodeBuffer(await fs.promises.readFile(filePath));
}

function decodeBuffer(raw: Buffer): { text: string; lineEnding: 'lf' | 'crlf'; bom: boolean } {
  // BOM = EF BB BF
  const bom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  const body = bom ? raw.slice(3) : raw;
  const text = body.toString('utf8');
  // Classify line ending by counting \r\n vs \n pairs. If \r\n dominates the
  // non-last lines, it's CRLF. Otherwise LF. A file with NO newlines at all
  // is classified LF by convention (Unix-default; nothing to preserve).
  const crlfCount = (text.match(/\r\n/g) || []).length;
  const lfCount = (text.match(/\n/g) || []).length - crlfCount;
  const lineEnding: 'lf' | 'crlf' = crlfCount > lfCount ? 'crlf' : 'lf';
  const normalized = lineEnding === 'crlf' ? text.replace(/\r\n/g, '\n') : text;
  return { text: normalized, lineEnding, bom };
}

/**
 * Inverse of readFileWithMetadata: re-encode normalized text back to the
 * original on-disk byte layout. Called by writeImpl/editImpl/multiEditImpl
 * right before fs.writeFileSync so preservation is automatic.
 */
export function encodeWithMetadata(text: string, meta?: { lineEnding?: 'lf' | 'crlf'; bom?: boolean }): Buffer {
  const restored = meta?.lineEnding === 'crlf' ? text.replace(/\n/g, '\r\n') : text;
  const body = Buffer.from(restored, 'utf8');
  if (meta?.bom) return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]);
  return body;
}

/**
 * Canonicalize a path for safety checks. Uses `path.resolve()` to fold `..`
 * segments and `fs.realpathSync()` to resolve symlinks. If the file doesn't
 * exist yet (brand-new Write), we realpath the parent directory and
 * re-append the basename so symlink'd parents still get canonicalized.
 *
 * Stress test #3 (path traversal via `..`) + #4 (symlink escape).
 */
export function canonicalizePath(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    // File may not exist — try the parent.
    const parent = path.dirname(abs);
    const base = path.basename(abs);
    try {
      return path.join(fs.realpathSync(parent), base);
    } catch {
      return abs;
    }
  }
}

/** Shorten abs paths under cwd to relative (`app/lib/foo.dart`) so tool
 * result headers don't blow 80 chars with `/Users/zielinski/develop/...`.
 * Falls back to the absolute path if the file isn't under cwd. */
export function relToCwd(abs: string, cwd?: string): string {
  if (!cwd || !path.isAbsolute(abs)) return abs;
  const prefix = cwd.endsWith('/') ? cwd : cwd + '/';
  if (abs === cwd) return '.';
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
}


/** Debug counter — size of the per-ctx readPaths set. Consumed by
 *  debug-log.captureMemSnapshot to surface Read-tracking growth. */
export function __debugReadPathsCount(ctx: ReplContext): number {
  const set = readPaths.get(ctx);
  return set ? set.size : 0;
}
