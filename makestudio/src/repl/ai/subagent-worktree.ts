import { swallow } from '../../utils/log';
/**
 * subagent-worktree.ts — give a subagent its own git worktree so its
 * file edits land in an isolated branch that the caller can inspect or
 * discard cleanly.
 *
 * Use case: the main agent dispatches a subagent to "investigate the
 * auth flow and propose a refactor". By default that subagent shares
 * the caller's cwd, so any Write/Edit it makes lands directly in the
 * user's working tree. With `isolation: 'worktree'`, the subagent
 * runs against a fresh git worktree on a throwaway branch — its
 * edits exist in that branch, the user's working tree stays clean,
 * and the result message can include "branch=<name>, path=<wt>" so
 * the user can `git diff` and decide whether to merge.
 *
 * Cleanup: by default the worktree and branch are dropped after the
 * subagent completes (so an investigation that touched files leaves
 * nothing behind). When `keepWorktree: true` is passed, the worktree
 * survives so the user can inspect it manually.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export interface SubagentWorktreeHandle {
  /** Absolute path to the worktree root. */
  path: string;
  /** Branch name created for the subagent. */
  branch: string;
  /** Original repo root (for `git worktree remove` later). */
  originalRoot: string;
}

/**
 * Synchronous because git worktree add is fast (~100ms) and we want
 * the subagent to find a ready worktree before its first tool call.
 */
export function createSubagentWorktree(
  rootPath: string,
  slug: string,
): SubagentWorktreeHandle {
  // Resolve to git repo root via `git rev-parse --show-toplevel`.
  let root: string;
  try {
    root = execSync('git rev-parse --show-toplevel', { cwd: rootPath, timeout: 5_000 })
      .toString().trim();
  } catch (err: any) {
    throw new Error(
      `Cannot create subagent worktree — ${rootPath} is not inside a git repo: ${err.message}`,
    );
  }

  // Sanitise slug for filesystem + branch name.
  const safe = slug.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40) || 'subagent';
  const branch = `subagent/${safe}-${Date.now().toString(36)}`;
  const wtPath = path.join(path.dirname(root), `.makestudio-subagent-${path.basename(root)}-${safe}-${Date.now().toString(36)}`);

  // Capture base sha so the worktree starts from a stable point.
  const baseSha = execSync('git rev-parse HEAD', { cwd: root, timeout: 5_000 }).toString().trim();

  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  execSync(
    `git worktree add -B "${branch}" "${wtPath}" "${baseSha}"`,
    { cwd: root, timeout: 30_000, stdio: 'pipe' },
  );

  return { path: wtPath, branch, originalRoot: root };
}

/**
 * Tear down the worktree. Always succeeds (errors are logged to
 * stderr but not thrown — a subagent finishing is more important
 * than a clean cleanup).
 */
export function removeSubagentWorktree(handle: SubagentWorktreeHandle, keepBranch = false): void {
  if (!handle?.path || !handle?.originalRoot) return;
  try {
    execSync(`git worktree remove --force "${handle.path}"`, {
      cwd: handle.originalRoot, timeout: 15_000, stdio: 'pipe',
    });
  } catch (err: any) {
    process.stderr.write(`[subagent-worktree] remove failed for ${handle.path}: ${err.message}\n`);
  }
  if (!keepBranch) {
    try {
      execSync(`git branch -D "${handle.branch}"`, {
        cwd: handle.originalRoot, timeout: 5_000, stdio: 'pipe',
      });
    } catch (err) { swallow(err); }
  }
}

/**
 * Detect whether the caller wants worktree isolation. Honours both
 * the explicit `isolation: 'worktree'` field on the dispatch input
 * AND the older boolean shorthand `worktree: true` for compatibility.
 */
export function wantsWorktreeIsolation(input: any): boolean {
  if (!input || typeof input !== 'object') return false;
  if (input.isolation === 'worktree') return true;
  if (input.worktree === true) return true;
  return false;
}

/**
 * Convert the worktree handle to the post-execution metadata block we
 * embed in the subagent's result so the user knows where to look.
 */
export function summariseWorktree(handle: SubagentWorktreeHandle | null, kept: boolean): string {
  if (!handle) return '';
  if (kept) {
    return `\n\n[worktree retained — branch=${handle.branch}, path=${handle.path}. Inspect with: git -C ${handle.originalRoot} diff main...${handle.branch}]`;
  }
  return `\n\n[worktree branch ${handle.branch} discarded after subagent completion]`;
}
