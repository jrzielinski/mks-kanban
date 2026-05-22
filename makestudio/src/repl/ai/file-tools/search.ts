import { swallow } from '../../../utils/log';
/**
 * File tool — search topic. Extracted from file-tools.ts.
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
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import fastGlob from 'fast-glob';
import { ReplContext } from '../../context';
import { ToolDefinition } from '../tools';
import { subprocessEnv } from '../../subprocess-env';
import { markRead, wasRead, requireAbsolute, readFileWithMetadata, encodeWithMetadata, canonicalizePath, relToCwd, expandTilde as _expandTilde } from './path-utils';


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
// Memoize Glob across turns — same pattern + cwd, with a cheap freshness
// gate (mtime of the cwd directory). When you Glob `**/*.ts` 4 times in a
// session and nothing changed in the tree, we skip fastGlob entirely
// (saves 200-2000ms each time on big repos). Bounded LRU so the map
// can't grow unboundedly. Invalidates as soon as the parent dir's mtime
// changes — any add/rename/delete in cwd flips it.
interface GlobCacheEntry { matches: string[]; cwdMtime: number; at: number }
const GLOB_MEMO_MAX = 64;
const GLOB_MEMO_TTL_MS = 5 * 60 * 1000;
const globMemo: Map<string, GlobCacheEntry> = new Map();

function globMemoKey(pattern: string, cwd: string): string {
  return `${cwd}::${pattern}`;
}

function evictGlobMemo(now: number): void {
  for (const [k, v] of globMemo) {
    if (now - v.at > GLOB_MEMO_TTL_MS) globMemo.delete(k);
  }
  while (globMemo.size > GLOB_MEMO_MAX) {
    const first = globMemo.keys().next().value;
    if (first === undefined) break;
    globMemo.delete(first);
  }
}

// Tilde-expansion is shared with read/edit/write — see path-utils.ts.
const expandTilde = _expandTilde;

export async function globImpl(input: any, ctx: ReplContext): Promise<string> {
  const pattern: string = input.pattern;
  const cwd: string = expandTilde(input.path) || ctx.cwd || process.cwd();

  // Memo lookup — gated by cwd dir mtime. If the directory was touched
  // since the last cache write, recompute. Skipped when input.noCache=true.
  const key = globMemoKey(pattern, cwd);
  let cwdMtime = 0;
  try { cwdMtime = fs.statSync(cwd).mtimeMs; } catch (err) { swallow(err); }
  const now = Date.now();
  evictGlobMemo(now);
  if (!input.noCache && cwdMtime > 0) {
    const cached = globMemo.get(key);
    if (cached && cached.cwdMtime === cwdMtime && now - cached.at < GLOB_MEMO_TTL_MS) {
      // Refresh recency (LRU) by re-inserting.
      globMemo.delete(key);
      globMemo.set(key, { ...cached, at: now });
      const matches = cached.matches;
      if (matches.length === 0) {
        let hint = '';
        try { hint = require('./search-hint').globHint(pattern, cwd); } catch (err) { swallow(err); }
        return `No files matched pattern: ${pattern}${hint ? '\n' + hint : ''}`;
      }
      const LIMIT_HIT = 100;
      if (matches.length <= LIMIT_HIT) return matches.join('\n');
      return matches.slice(0, LIMIT_HIT).join('\n') +
        `\n(Results are truncated. Consider using a more specific path or pattern.)`;
    }
  }

  const matches: string[] = await fastGlob(pattern, {
    cwd, absolute: true, dot: false, followSymbolicLinks: false,
    ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/coverage/**'],
  });
  const withStat = matches
    .map(p => { try { return { p, mtime: fs.statSync(p).mtimeMs }; } catch { return null; } })
    .filter(Boolean) as Array<{ p: string; mtime: number }>;
  withStat.sort((a, b) => b.mtime - a.mtime);
  // Relativize to cwd so hundreds of `/Users/zielinski/...` prefixes don't
  // dominate the tool output. Matches Claude Code's `toRelativePath`.
  const paths = withStat.map(x => relToCwd(x.p, ctx.cwd));

  // Cache the full path list (pre-truncation) under the cwd-mtime gate.
  // On the next identical Glob with unchanged cwd, we serve from here.
  if (cwdMtime > 0) {
    globMemo.set(key, { matches: paths.slice(), cwdMtime, at: now });
  }

  if (paths.length === 0) {
    let hint = '';
    try { hint = require('./search-hint').globHint(pattern, cwd); } catch (err) { swallow(err); }
    return `No files matched pattern: ${pattern}${hint ? '\n' + hint : ''}`;
  }

  // Matches Claude Code's GlobTool (src/tools/GlobTool/GlobTool.ts): cap at
  // 100 results, sort by mtime desc. On truncation, the model is told
  // verbatim to narrow the pattern — NO homemade breakdown. Open-ended
  // discovery belongs in the Agent tool (dispatch_agent subagent_type='explore'),
  // not in Glob's output.
  // Matches Claude Code's GlobTool: cap at 100, sort by mtime desc. On
  // truncation the model is told to narrow the pattern; open-ended
  // discovery is the Agent/explore subagent's job (see dispatch_agent).
  const LIMIT = 100;
  if (paths.length <= LIMIT) return paths.join('\n');
  return paths.slice(0, LIMIT).join('\n') +
    `\n(Results are truncated. Consider using a more specific path or pattern.)`;
}

// Module-level flag — once we've seen `rg` ENOENT, every future
// grepImpl call routes straight to the GNU grep fallback without
// re-spawning. Avoids burning 5 consecutive tool failures on the
// same root cause.
let rgUnavailable = false;

function abortSignalFor(ctx: ReplContext): AbortSignal | undefined {
  return (ctx as any).currentAbortController?.signal;
}

/**
 * GNU grep fallback for environments without ripgrep.
 *
 * Translates the rg flag set we use to grep equivalents. Caveats:
 *   - --multiline is not supported by GNU grep (we drop it and warn)
 *   - --type=ts becomes --include='*.ts' (best-effort mapping)
 *   - default excludes (node_modules, dist, build, coverage, .git)
 *     map directly to --exclude-dir
 *
 * Output shape matches what rg emits in the same mode so the rest
 * of grepImpl (buffer cap, abort signal, head-limit slicing) keeps
 * working.
 */
async function runGnuGrepFallback(
  pattern: string,
  searchPath: string,
  input: any,
  abortSignal: AbortSignal | undefined,
  maxBufferBytes: number,
  hardTimeoutMs: number,
): Promise<string> {
  const mode: 'content' | 'files_with_matches' | 'count' = input.output_mode || 'files_with_matches';
  const headLimit = Math.max(1, input.head_limit ?? 250);
  const offset = Math.max(0, input.offset ?? 0);

  const args: string[] = ['-rE'];
  if (input['-i']) args.push('-i');
  if (mode === 'content') {
    if (input['-n']) args.push('-n');
    if (typeof input['-A'] === 'number') args.push('-A', String(input['-A']));
    if (typeof input['-B'] === 'number') args.push('-B', String(input['-B']));
    if (typeof input['-C'] === 'number') args.push('-C', String(input['-C']));
  } else if (mode === 'files_with_matches') {
    args.push('-l');
  } else {
    args.push('-c');
  }

  // Best-effort --type=X → --include='*.x' mapping for the common cases.
  const TYPE_MAP: Record<string, string[]> = {
    ts: ['*.ts', '*.tsx'],
    js: ['*.js', '*.jsx', '*.mjs', '*.cjs'],
    py: ['*.py'],
    go: ['*.go'],
    rust: ['*.rs'],
    md: ['*.md'],
    json: ['*.json'],
    yaml: ['*.yaml', '*.yml'],
    sh: ['*.sh', '*.bash'],
  };
  if (input.type && TYPE_MAP[input.type]) {
    for (const inc of TYPE_MAP[input.type]) args.push('--include=' + inc);
  }
  if (input.glob && typeof input.glob === 'string') {
    // Translate glob: positive (foo) → --include, negative (!foo) → --exclude
    const g = input.glob.trim();
    if (g.startsWith('!')) args.push('--exclude=' + g.slice(1));
    else args.push('--include=' + g);
  }
  if (input.includeDeps !== true) {
    args.push('--exclude-dir=node_modules');
    args.push('--exclude-dir=dist');
    args.push('--exclude-dir=build');
    args.push('--exclude-dir=coverage');
    args.push('--exclude-dir=.git');
  }

  args.push('--', pattern, searchPath);

  let proc;
  try {
    proc = spawn('grep', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err: any) {
    return `Error: neither ripgrep (rg) nor GNU grep is available on PATH. Install ripgrep (cargo install ripgrep / apt install ripgrep) or run from a system where grep exists.`;
  }

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let truncated = false;

  proc.stdout.on('data', (c: Buffer) => {
    stdoutBytes += c.length;
    if (stdoutBytes <= maxBufferBytes) stdoutChunks.push(c);
    else if (!truncated) { truncated = true; try { proc.kill('SIGTERM'); } catch (err) { swallow(err); } }
  });
  proc.stderr.on('data', (c: Buffer) => {
    if (stderrBytes < 4096) { stderrChunks.push(c); stderrBytes += c.length; }
  });

  let aborted = false;
  const onAbort = () => { aborted = true; try { proc.kill('SIGTERM'); } catch (err) { swallow(err); } };
  if (abortSignal) {
    if (abortSignal.aborted) onAbort();
    else abortSignal.addEventListener('abort', onAbort, { once: true });
  }
  const hardTimer = setTimeout(() => {
    aborted = true;
    try { proc.kill('SIGKILL'); } catch (err) { swallow(err); }
  }, hardTimeoutMs);

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: any }>((resolve) => {
    proc.on('error', (err: any) => {
      clearTimeout(hardTimer);
      resolve({ code: null, signal: null, spawnError: err });
    });
    proc.on('close', (code, signal) => {
      clearTimeout(hardTimer);
      resolve({ code, signal });
    });
  });
  if (abortSignal) {
    try { (abortSignal as any).removeEventListener?.('abort', onAbort); } catch (err) { swallow(err); }
  }

  if (exit.spawnError) {
    return `Error invoking GNU grep fallback: ${exit.spawnError.message || exit.spawnError}`;
  }
  if (aborted) return `(grep cancelled${truncated ? ' — output exceeded 20MB' : ''})`;
  if (exit.code !== 0 && exit.code !== 1) {
    const err = Buffer.concat(stderrChunks).toString('utf8').trim();
    if (err) throw new Error(`grep failed: ${err.slice(0, 500)}`);
  }
  const lines = Buffer.concat(stdoutChunks).toString('utf8').split('\n').filter(Boolean);
  if (lines.length === 0) {
    let hint = '';
    try {
      hint = require('./search-hint').grepHint(pattern, searchPath, {
        caseInsensitive: !!input['-i'],
        multiline: !!input.multiline,
      });
    } catch (err) { swallow(err); }
    const multilineNote = input.multiline ? '\n[note: multiline=true was requested but GNU grep fallback ignores it — install ripgrep for multiline support]' : '';
    return `No matches for /${pattern}/ in ${searchPath}.${hint ? '\n' + hint : ''}${multilineNote}`;
  }
  const windowed = offset > 0 ? lines.slice(offset) : lines;
  const head = windowed.slice(0, headLimit);
  const shownUpTo = offset + head.length;
  const remaining = lines.length - shownUpTo;
  let note = '';
  if (offset > 0 || remaining > 0) {
    const parts = [`showing ${offset + 1}–${shownUpTo} of ${lines.length}`];
    if (remaining > 0) parts.push(`${remaining} more — pass offset=${shownUpTo} to continue`);
    note = `\n\n[${parts.join(' · ')}]`;
  }
  const fallbackBanner = '[grep-fallback: ripgrep not on PATH; using GNU grep — multiline/type/glob support reduced]';
  return fallbackBanner + '\n' + head.join('\n') + note;
}

// Async ripgrep — honours ctx.currentAbortController.signal so Esc-Esc
// in the TUI cancels a long grep mid-stream instead of waiting for it
// to finish. The previous spawnSync version blocked the entire turn.
// Output is collected via stdout streaming with a 20MB buffer cap;
// stderr collected separately so we can distinguish "no matches" (rg
// exit 1, empty stderr) from "rg crashed" (non-1 status, error text).
export async function grepImpl(input: any, ctx: ReplContext): Promise<string> {
  const pattern: string = input.pattern;
  const searchPath: string = expandTilde(input.path) || ctx.cwd || process.cwd();
  const mode: 'content' | 'files_with_matches' | 'count' = input.output_mode || 'files_with_matches';
  const headLimit = Math.max(1, input.head_limit ?? 250);
  // offset lets the LLM page past the first head_limit results without
  // re-grep'ing. Port of Claude Code's GrepTool offset parameter. rg
  // doesn't natively support offset, so we slice in-memory after capture.
  const offset = Math.max(0, input.offset ?? 0);

  const args: string[] = [];
  if (input['-i']) args.push('-i');
  if (input.multiline) args.push('-U', '--multiline-dotall');

  if (mode === 'content') {
    if (input['-n']) args.push('-n');
    if (typeof input['-A'] === 'number') args.push('-A', String(input['-A']));
    if (typeof input['-B'] === 'number') args.push('-B', String(input['-B']));
    if (typeof input['-C'] === 'number') args.push('-C', String(input['-C']));
  } else if (mode === 'files_with_matches') {
    args.push('-l');
  } else {
    args.push('-c');
  }

  if (input.glob) args.push('--glob', input.glob);
  if (input.type) args.push('--type', input.type);

  // Default excludes — ripgrep already respects .gitignore, but a repo
  // without one (or running rg from a parent dir) would otherwise dump
  // hundreds of matches from node_modules / dist / build / coverage.
  // input.includeDeps=true bypasses these. Always passed even when
  // input.glob is set so explicit user globs don't silently swallow
  // node_modules just because the user didn't think to exclude it.
  if (input.includeDeps !== true) {
    args.push(
      '--glob', '!**/node_modules/**',
      '--glob', '!**/dist/**',
      '--glob', '!**/build/**',
      '--glob', '!**/coverage/**',
      '--glob', '!**/.git/**',
    );
  }

  args.push('--no-heading', '--color=never', pattern, searchPath);

  const MAX_BUFFER_BYTES = 20 * 1024 * 1024;
  const HARD_TIMEOUT_MS = 60_000; // belt + suspenders alongside abort signal

  // ── ripgrep availability gate ──────────────────────────────────
  // ENOENT on `rg` is recoverable: GNU grep is on virtually every
  // POSIX system. Rather than letting the model burn 5 consecutive
  // tool failures + a circuit-breaker on the same root cause, we
  // detect the missing binary ONCE per session and route every
  // subsequent Grep through `grep -rE` with equivalent flags.
  // The translation isn't 1:1 (no --multiline, no --type), so we
  // surface caveats to the model when those flags were requested.
  if (rgUnavailable) {
    return runGnuGrepFallback(pattern, searchPath, input, abortSignalFor(ctx), MAX_BUFFER_BYTES, HARD_TIMEOUT_MS);
  }

  let proc;
  try {
    proc = spawn('rg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      rgUnavailable = true;
      return runGnuGrepFallback(pattern, searchPath, input, abortSignalFor(ctx), MAX_BUFFER_BYTES, HARD_TIMEOUT_MS);
    }
    throw err;
  }

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let truncated = false;

  proc.stdout.on('data', (c: Buffer) => {
    stdoutBytes += c.length;
    if (stdoutBytes <= MAX_BUFFER_BYTES) {
      stdoutChunks.push(c);
    } else if (!truncated) {
      truncated = true;
      try { proc.kill('SIGTERM'); } catch (err) { swallow(err); }
    }
  });
  proc.stderr.on('data', (c: Buffer) => {
    if (stderrBytes < 4096) {
      stderrChunks.push(c);
      stderrBytes += c.length;
    }
  });

  const abortSignal: AbortSignal | undefined = (ctx as any).currentAbortController?.signal;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    try { proc.kill('SIGTERM'); } catch (err) { swallow(err); }
  };
  if (abortSignal) {
    if (abortSignal.aborted) onAbort();
    else abortSignal.addEventListener('abort', onAbort, { once: true });
  }
  const hardTimer = setTimeout(() => {
    aborted = true;
    try { proc.kill('SIGKILL'); } catch (err) { swallow(err); }
  }, HARD_TIMEOUT_MS);

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: any }>((resolve) => {
    proc.on('error', (err: any) => {
      clearTimeout(hardTimer);
      // ENOENT here means the binary itself is missing (vs. a runtime
      // error from a present binary). Resolve with the error so the
      // caller can route to the GNU grep fallback.
      resolve({ code: null, signal: null, spawnError: err });
    });
    proc.on('close', (code, signal) => {
      clearTimeout(hardTimer);
      resolve({ code, signal });
    });
  });
  if (exit.spawnError?.code === 'ENOENT') {
    rgUnavailable = true;
    return runGnuGrepFallback(pattern, searchPath, input, abortSignalFor(ctx), MAX_BUFFER_BYTES, HARD_TIMEOUT_MS);
  }
  if (exit.spawnError) throw exit.spawnError;
  if (abortSignal) {
    try { (abortSignal as any).removeEventListener?.('abort', onAbort); } catch (err) { swallow(err); }
  }

  if (aborted) return `(grep cancelled${truncated ? ' — output exceeded 20MB' : ''})`;
  if (exit.code !== 0 && exit.code !== 1) {
    // 1 = no matches; anything else is a real error. Surface stderr so
    // the model can see if e.g. the pattern was a bad regex.
    const err = Buffer.concat(stderrChunks).toString('utf8').trim();
    if (err) throw new Error(`rg failed: ${err.slice(0, 500)}`);
  }
  const lines = Buffer.concat(stdoutChunks).toString('utf8').split('\n').filter(Boolean);
  if (lines.length === 0) {
    let hint = '';
    try {
      hint = require('./search-hint').grepHint(pattern, searchPath, {
        caseInsensitive: !!input['-i'],
        multiline: !!input.multiline,
      });
    } catch (err) { swallow(err); }
    return `No matches for /${pattern}/ in ${searchPath}.${hint ? '\n' + hint : ''}`;
  }
  // Apply offset first, then head_limit — mirrors Claude Code formatLimitInfo.
  const windowed = offset > 0 ? lines.slice(offset) : lines;
  const head = windowed.slice(0, headLimit);
  const shownUpTo = offset + head.length;
  const remaining = lines.length - shownUpTo;
  let note = '';
  if (offset > 0 || remaining > 0) {
    const parts = [`showing ${offset + 1}–${shownUpTo} of ${lines.length}`];
    if (remaining > 0) parts.push(`${remaining} more — pass offset=${shownUpTo} to continue`);
    note = `\n\n[${parts.join(' · ')}]`;
  }
  return head.join('\n') + note;
}

