/**
 * session-constraint-verifier.ts
 *
 * Closes the loop on session-pinned constraints (see session-constraints.ts)
 * by running each constraint's verifyCommand at end-of-turn. The verifier
 * is **language-agnostic by design** — it does not know about TypeScript,
 * Node, Python, Rust, Go, Flutter, or Java. The LLM that pinned the
 * constraint chose a shell command that works for the project; we just
 * spawn it and read the exit code.
 *
 * Contract per pinned constraint:
 *   - verifyCommand absent  → SKIP   ("model must self-verify")
 *   - verifyCommand present → PASS if exit==0, FAIL otherwise
 *
 * Anything beyond that (test-coverage walking, sibling-test discovery,
 * runner detection) belongs to project-specific tools the user/LLM can
 * call themselves — not the agent runtime. Hard-coding `.ts`/`.tsx` paths
 * and `vitest`/`jest` lookups would tie makestudio to one ecosystem,
 * which is exactly the failure mode the project's CLAUDE.md forbids.
 */

import { spawnSync } from 'child_process';
import type { ReplContext } from './context';
import { listConstraints } from './session-constraints';

export type ConstraintStatus = 'PASS' | 'FAIL' | 'SKIP';

export interface ConstraintResult {
  constraint: string;
  status: ConstraintStatus;
  detail: string;
}

/** Read cwd off the ctx for spawning verifier commands. Falls back to
 *  the process cwd so tests don't need a populated ctx. */
function resolveCwd(ctx: ReplContext): string {
  const fromCtx = (ctx as any)?.cwd;
  if (typeof fromCtx === 'string' && fromCtx.length > 0) return fromCtx;
  return process.cwd();
}

interface RunOptions {
  cwd: string;
  timeoutMs?: number;
}

/** Pure-shell runner. Exposed for testability — the verifier just shells
 *  out and reads the exit code. No interpretation of stdout/stderr beyond
 *  surfacing a tail of stderr when the command fails. */
export function runShell(
  command: string,
  opts: RunOptions,
): { exitCode: number; stderrTail: string; timedOut: boolean } {
  const proc = spawnSync('bash', ['-lc', command], {
    cwd: opts.cwd,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 180_000,
  });
  const stderr = (proc.stderr || '') + (proc.stdout || '');
  const stderrTail = stderr.trim().split('\n').slice(-3).join(' / ').slice(0, 240);
  const timedOut = (proc as any).signal === 'SIGTERM' && (proc.error as any)?.code === 'ETIMEDOUT';
  return {
    exitCode: typeof proc.status === 'number' ? proc.status : -1,
    stderrTail,
    timedOut,
  };
}

/**
 * Public entry. Returns one ConstraintResult per pinned constraint —
 * caller decides how to present them.
 */
export function verifyConstraints(ctx: ReplContext): ConstraintResult[] {
  const constraints = listConstraints(ctx);
  if (constraints.length === 0) return [];
  const cwd = resolveCwd(ctx);
  const results: ConstraintResult[] = [];
  for (const c of constraints) {
    if (!c.verifyCommand) {
      results.push({
        constraint: c.text,
        status: 'SKIP',
        detail: 'no verifyCommand pinned — model must self-verify',
      });
      continue;
    }
    try {
      const r = runShell(c.verifyCommand, { cwd });
      if (r.exitCode === 0) {
        results.push({
          constraint: c.text,
          status: 'PASS',
          detail: `\`${c.verifyCommand}\` exited 0`,
        });
      } else if (r.timedOut) {
        results.push({
          constraint: c.text,
          status: 'FAIL',
          detail: `\`${c.verifyCommand}\` timed out`,
        });
      } else {
        results.push({
          constraint: c.text,
          status: 'FAIL',
          detail: `\`${c.verifyCommand}\` exited ${r.exitCode}` + (r.stderrTail ? ` — ${r.stderrTail}` : ''),
        });
      }
    } catch (err: any) {
      results.push({
        constraint: c.text,
        status: 'FAIL',
        detail: `\`${c.verifyCommand}\` failed to spawn: ${err?.message || String(err)}`,
      });
    }
  }
  return results;
}

/** Helper: render a list of results as a single bridge-friendly message.
 * Returns null when every constraint passed (no need to nag). */
export function formatVerifierResults(results: ConstraintResult[]): string | null {
  if (results.length === 0) return null;
  const failed = results.filter((r) => r.status === 'FAIL');
  if (failed.length === 0) {
    return `[constraints] ${results.length} pinned, all PASS`;
  }
  const rows = failed.map((r) => `  ✗ FAIL: ${r.constraint}\n      ${r.detail}`);
  return `[constraints] ${failed.length}/${results.length} unmet:\n${rows.join('\n')}`;
}
