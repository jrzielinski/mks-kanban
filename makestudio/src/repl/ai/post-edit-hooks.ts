import { swallow } from '../../utils/log';
/**
 * post-edit-hooks.ts
 *
 * Two safety nets against model-mentira:
 *
 * 1. Compile-gate per tool call (config-driven, language-agnostic)
 *    After every Edit / Write / MultiEdit, look up the file's extension
 *    in a per-PROJECT config and, if a hook is configured, run it.
 *    Exit==0 → ok; non-zero → append the stderr tail to the tool result
 *    so the model sees the breakage in the same turn.
 *
 *    The runtime knows ZERO about TypeScript, Node, Dart, Python, Rust,
 *    Go, Java, or anything else. It just runs whatever shell command
 *    the project owner mapped to the extension. Users configure what
 *    fits THEIR stack:
 *
 *        <projectRoot>/.makestudio/post-edit-hooks.json
 *        {
 *          ".ts":   "npx tsc --noEmit {file}",
 *          ".tsx":  "npx tsc --noEmit {file}",
 *          ".dart": "dart analyze {file}",
 *          ".py":   "python -m py_compile {file}",
 *          ".rs":   "cargo check --manifest-path Cargo.toml",
 *          ".go":   "go vet ./...",
 *          ".json": "python -m json.tool < {file} > /dev/null"
 *        }
 *
 *    Templating: `{file}` → file path relative to project root,
 *                `{absFile}` → absolute path,
 *                `{project}` → project root.
 *
 *    No config → no checks. Out of the box, makestudio is fully
 *    language-agnostic; per-language enforcement is opt-in.
 *
 * 2. Git-diff-gate at end of turn (language-agnostic)
 *    Tracks which files the model claimed to edit during the turn, then
 *    prints a compact summary of what git actually sees changed. Lets
 *    the user spot mismatches at a glance.
 *
 * Both checks are best-effort: errors in the hook itself never break
 * the turn — we swallow and move on.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { ReplContext } from '../context';

export interface CheckResult { ok: boolean; message?: string }

// ── Turn-scoped state ────────────────────────────────────────────────────────
// A Set of absolute paths edited during the current turn, per context.
const turnEdits: WeakMap<ReplContext, Set<string>> = new WeakMap();

export function clearTurnEdits(ctx: ReplContext): void {
  turnEdits.set(ctx, new Set());
  invalidateHookConfigCache(ctx);
}

export function trackEdit(ctx: ReplContext, absPath: string): void {
  let set = turnEdits.get(ctx);
  if (!set) { set = new Set(); turnEdits.set(ctx, set); }
  set.add(absPath);
}

export function getTurnEdits(ctx: ReplContext): Set<string> {
  return turnEdits.get(ctx) ?? new Set();
}

// ── Per-project hook configuration ───────────────────────────────────
// Cached per-ctx so we don't re-parse the JSON file on every edit. The
// cache is invalidated at turn boundary (clearTurnEdits) so changes the
// user makes mid-session take effect on the next turn without restart.

interface HookConfig { [extension: string]: string }
const hookConfigCache: WeakMap<ReplContext, HookConfig | null> = new WeakMap();

function invalidateHookConfigCache(ctx: ReplContext): void {
  hookConfigCache.delete(ctx);
}

/**
 * Pure-ish: load `.makestudio/post-edit-hooks.json` from the project
 * root. Returns an empty object when the file is missing, malformed,
 * or contains the wrong shape — never throws, never blocks a turn.
 *
 * Exposed for testability.
 */
export function loadHookConfig(projectRoot: string): HookConfig {
  if (!projectRoot) return {};
  const cfgPath = path.join(projectRoot, '.makestudio', 'post-edit-hooks.json');
  try {
    if (!fs.existsSync(cfgPath)) return {};
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: HookConfig = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k === 'string' && typeof v === 'string' && v.trim().length > 0) {
        // Normalise the extension key — accept both `.ts` and `ts`.
        const ext = k.startsWith('.') ? k.toLowerCase() : `.${k.toLowerCase()}`;
        out[ext] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function getHookConfig(ctx: ReplContext): HookConfig {
  const cached = hookConfigCache.get(ctx);
  if (cached !== undefined) return cached || {};
  const cfg = loadHookConfig(ctx.cwd || '');
  hookConfigCache.set(ctx, Object.keys(cfg).length === 0 ? null : cfg);
  return cfg;
}

/**
 * Pure: substitute `{file}`, `{absFile}`, `{project}` placeholders in a
 * hook command template. Quoting is the user's responsibility — the
 * substitutions are inserted as-is.
 *
 * Exposed for testability.
 */
export function expandHookCommand(
  template: string,
  values: { file: string; absFile: string; project: string },
): string {
  return template
    .replace(/\{file\}/g, values.file)
    .replace(/\{absFile\}/g, values.absFile)
    .replace(/\{project\}/g, values.project);
}

// ── Post-edit syntax check ───────────────────────────────────────────────────

export function runPostEditCheck(
  toolName: string,
  input: any,
  ctx: ReplContext,
): CheckResult {
  if (!['Edit', 'Write', 'MultiEdit'].includes(toolName)) return { ok: true };
  const filePath: string | undefined = input?.file_path;
  if (!filePath || !path.isAbsolute(filePath) || !fs.existsSync(filePath)) return { ok: true };
  const cfg = getHookConfig(ctx);
  const ext = path.extname(filePath).toLowerCase();
  const template = cfg[ext];
  if (!template) return { ok: true };
  const projectRoot = ctx.cwd || path.dirname(filePath);
  const rel = path.relative(projectRoot, filePath) || filePath;
  const command = expandHookCommand(template, {
    file: rel,
    absFile: filePath,
    project: projectRoot,
  });
  return runHookCommand(command, projectRoot, filePath);
}

function runHookCommand(command: string, cwd: string, filePath: string): CheckResult {
  try {
    const r = spawnSync('bash', ['-lc', command], {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (r.status === 0) return { ok: true };
    const tail = ((r.stderr || '') + (r.stdout || ''))
      .trim()
      .split('\n')
      .slice(-3)
      .join(' / ')
      .slice(0, 300);
    const exitDesc = typeof r.status === 'number' ? `exit ${r.status}` : 'spawn failed';
    return {
      ok: false,
      message: `${path.basename(filePath)}: ${exitDesc}${tail ? ` — ${tail}` : ''}`,
    };
  } catch {
    return { ok: true }; // never break the turn over a hook error
  }
}

// ── End-of-turn git diff summary ─────────────────────────────────────────────

/**
 * Print a compact summary of files the model edited this turn, with git's
 * view of line deltas. Lets the user verify claims without reading each file.
 */
export function formatTurnSummary(ctx: ReplContext): string | null {
  const edits = getTurnEdits(ctx);
  if (edits.size === 0) return null;

  // `git diff --numstat HEAD` returns "added\tremoved\tpath" per file.
  // We limit to the files edited this turn so other uncommitted changes
  // (earlier turns, manual edits) don't pollute the summary.
  let numstat: Record<string, { added: number; removed: number }> = {};
  try {
    const r = spawnSync('git', ['diff', '--numstat', 'HEAD'], {
      cwd: ctx.cwd, timeout: 5_000, encoding: 'utf8',
    });
    if (r.status === 0 && r.stdout) {
      for (const line of r.stdout.split('\n')) {
        const parts = line.split('\t');
        if (parts.length !== 3) continue;
        const added = parseInt(parts[0], 10) || 0;
        const removed = parseInt(parts[1], 10) || 0;
        const relPath = parts[2];
        const abs = path.resolve(ctx.cwd, relPath);
        numstat[abs] = { added, removed };
      }
    }
  } catch (err) { swallow(err); }

  // Also account for files the model "edited" but git sees untracked (new file).
  let untracked = new Set<string>();
  try {
    const r = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: ctx.cwd, timeout: 5_000, encoding: 'utf8',
    });
    if (r.status === 0 && r.stdout) {
      for (const line of r.stdout.split('\n')) {
        if (line) untracked.add(path.resolve(ctx.cwd, line));
      }
    }
  } catch (err) { swallow(err); }

  const rows: string[] = [];
  let silent = 0;
  for (const abs of edits) {
    const rel = relToCwd(abs, ctx.cwd);
    const stat = numstat[abs];
    if (stat && (stat.added > 0 || stat.removed > 0)) {
      // Lesson learned 2026-05-05: the model regularly hallucinates line
      // counts in its narrative summary that don't match git. Prepend the
      // GROUND-TRUTH before/after counts so the user can compare reality
      // to the model's claim at a glance. We pull "before" via
      // `git show HEAD:<rel>`; "after" via fs read; both best-effort,
      // fall back to the +/- format when either fails.
      const counts = readBeforeAfterCounts(abs, rel, ctx.cwd);
      if (counts) {
        const delta = counts.after - counts.before;
        const sign = delta >= 0 ? '+' : '';
        rows.push(`  ${rel}  ${counts.before} → ${counts.after} (Δ${sign}${delta}; +${stat.added} -${stat.removed})`);
      } else {
        rows.push(`  ${rel}  +${stat.added} -${stat.removed}`);
      }
    } else if (untracked.has(abs)) {
      let lines = 0;
      try { lines = countLines(fs.readFileSync(abs, 'utf8')); } catch (err) { swallow(err); }
      rows.push(`  ${rel}  (new, ${lines} lines)`);
    } else {
      // Edited by tool but git sees no change vs HEAD. Likely the model
      // wrote identical content, or the file was reverted. Flag it.
      silent++;
      rows.push(`  ${rel}  (no net change vs HEAD)`);
    }
  }

  const header = `Files touched this turn (${edits.size})${silent > 0 ? ` — ${silent} with no net change:` : ':'}`;
  return `${header}\n${rows.join('\n')}`;
}

/**
 * Pure: count "\n" in a string. Empty string is 0 lines (not 1) so an
 * empty file doesn't read as having content. Matches `wc -l` semantics
 * for files that end in a newline.
 */
export function countLines(text: string): number {
  if (!text) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  // No trailing newline → there's still a logical last line with content.
  if (text.length > 0 && text.charCodeAt(text.length - 1) !== 10) n++;
  return n;
}

/** Resolve before/after line counts for a tracked file. Returns null when
 * either side fails (file deleted, git unavailable, path outside repo). */
export function readBeforeAfterCounts(
  abs: string,
  relPath: string,
  cwd?: string,
): { before: number; after: number } | null {
  if (!cwd) return null;
  let beforeText = '';
  try {
    const r = spawnSync('git', ['show', `HEAD:${relPath}`], {
      cwd, timeout: 5_000, encoding: 'utf8',
    });
    if (r.status !== 0) return null;
    beforeText = r.stdout || '';
  } catch { return null; }
  let afterText = '';
  try { afterText = fs.readFileSync(abs, 'utf8'); } catch { return null; }
  return { before: countLines(beforeText), after: countLines(afterText) };
}

function relToCwd(abs: string, cwd?: string): string {
  if (!cwd || !path.isAbsolute(abs)) return abs;
  const prefix = cwd.endsWith('/') ? cwd : cwd + '/';
  if (abs === cwd) return '.';
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
}
