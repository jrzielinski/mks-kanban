import { swallow } from '../utils/log';
/**
 * worktree.ts
 *
 * Per-DUM git worktree isolation.
 *
 * For risky/experimental DUMs, create an isolated git worktree so that any
 * failure doesn't pollute the main branch. On success the branch is merged
 * back; on failure the worktree is removed.
 *
 * Layout: <repo>/.makestudio/worktrees/<dum-number>/   (the checked-out copy)
 *         branch:  dum/<dum-number>                    (the ephemeral branch)
 *
 * Base: current HEAD (we want the worktree to start from in-progress work,
 * not origin — other DUMs may have already committed on this branch).
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export interface WorktreeHandle {
  worktreePath: string;       // absolute path inside <repo>/.makestudio/worktrees/<dum>
  branch: string;             // dum/<dum-number>
  baseSha: string;            // HEAD commit at creation time
  originalRepo: string;       // repo root where worktree was registered
  originalBranch: string | null;
}

function repoRoot(cwd: string): string {
  try {
    return execSync('git rev-parse --show-toplevel', { cwd, timeout: 5_000 })
      .toString().trim();
  } catch {
    throw new Error(`Not a git repo: ${cwd}`);
  }
}

function currentBranch(cwd: string): string | null {
  try {
    const out = execSync('git symbolic-ref --quiet --short HEAD', { cwd, timeout: 5_000 })
      .toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

function currentSha(cwd: string): string {
  return execSync('git rev-parse HEAD', { cwd, timeout: 5_000 }).toString().trim();
}

function dumSlug(dumNumber: string): string {
  // dum/<number> — git branch names don't accept some chars, sanitize.
  return dumNumber.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function worktreePathFor(root: string, dumNumber: string): string {
  return path.join(root, '.makestudio', 'worktrees', dumSlug(dumNumber));
}

function branchNameFor(dumNumber: string): string {
  return `dum/${dumSlug(dumNumber)}`;
}

/**
 * Ensure the main repo has a clean-enough state to branch off. We don't
 * require clean working tree (there may be intermediate changes across
 * DUMs we want to preserve), but we do require that we can resolve HEAD.
 */
export function canEnterWorktree(cwd: string): { ok: boolean; reason?: string } {
  try {
    const root = repoRoot(cwd);
    currentSha(root);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e.message };
  }
}

/**
 * Create (or resume) a worktree for the given DUM.
 * - If the worktree dir already exists with a valid HEAD, reuse it (fast path).
 * - Otherwise create: `git worktree add -B dum/<slug> <path> <baseSha>`
 */
export function enterWorktreeForDum(cwd: string, dumNumber: string): WorktreeHandle {
  const root = repoRoot(cwd);
  const wtPath = worktreePathFor(root, dumNumber);
  const branch = branchNameFor(dumNumber);
  const originalBranch = currentBranch(root);
  const baseSha = currentSha(root);

  // Fast resume: if the worktree dir already exists and is registered, reuse.
  let existed = false;
  try {
    if (fs.existsSync(wtPath)) {
      const headOut = execSync('git rev-parse HEAD', { cwd: wtPath, timeout: 5_000 })
        .toString().trim();
      if (headOut) existed = true;
    }
  } catch (err) { swallow(err); }

  if (!existed) {
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    // -B: reset the branch if it already exists, so a previous aborted run
    // doesn't leave an orphan that blocks `worktree add`.
    execSync(
      `git worktree add -B "${branch}" "${wtPath}" "${baseSha}"`,
      { cwd: root, timeout: 30_000, stdio: 'pipe' },
    );
  }

  return {
    worktreePath: wtPath,
    branch,
    baseSha,
    originalRepo: root,
    originalBranch,
  };
}

/**
 * Merge the worktree's branch back into the original branch, then remove
 * the worktree. Used on DUM success.
 * Returns { ok, mergeMessage } — caller decides whether to proceed if merge
 * conflicts.
 */
export function exitWorktreeAndMerge(
  handle: WorktreeHandle,
): { ok: boolean; message: string } {
  const { originalRepo, originalBranch, branch, worktreePath } = handle;

  if (!originalBranch) {
    return { ok: false, message: 'Original branch unknown — cannot merge. Worktree kept for manual recovery.' };
  }

  // Are there any commits on the worktree branch beyond baseSha?
  let aheadCount = 0;
  try {
    const out = execSync(
      `git rev-list --count "${handle.baseSha}..${branch}"`,
      { cwd: originalRepo, timeout: 10_000 },
    ).toString().trim();
    aheadCount = parseInt(out, 10) || 0;
  } catch (err) { swallow(err); }

  if (aheadCount === 0) {
    // Nothing to merge — just remove the worktree.
    removeWorktree(handle);
    return { ok: true, message: 'No new commits in worktree, nothing to merge.' };
  }

  // Attempt merge
  try {
    execSync(
      `git merge --no-ff -m "merge: [${branch}] auto-merge from DUM worktree" "${branch}"`,
      { cwd: originalRepo, timeout: 60_000, stdio: 'pipe' },
    );
    removeWorktree(handle);
    return { ok: true, message: `Merged ${aheadCount} commit(s) from ${branch}.` };
  } catch (e: any) {
    // Merge failed — abort the merge attempt, keep the worktree for manual inspection
    try {
      execSync('git merge --abort', { cwd: originalRepo, timeout: 10_000, stdio: 'pipe' });
    } catch (err) { swallow(err); }
    return {
      ok: false,
      message: `Merge falhou (provavelmente conflito). Worktree preservada em ${worktreePath}, branch ${branch}. Resolva manualmente.\n\n${e.stderr?.toString() || e.message}`,
    };
  }
}

/**
 * Remove the worktree AND its branch (destructive).
 * Used on DUM failure when we want to discard the work entirely.
 */
export function exitWorktreeAndDiscard(handle: WorktreeHandle): void {
  removeWorktree(handle);
  try {
    execSync(`git branch -D "${handle.branch}"`, {
      cwd: handle.originalRepo, timeout: 5_000, stdio: 'pipe',
    });
  } catch (err) { swallow(err); }
}

function removeWorktree(handle: WorktreeHandle): void {
  try {
    execSync(
      `git worktree remove --force "${handle.worktreePath}"`,
      { cwd: handle.originalRepo, timeout: 30_000, stdio: 'pipe' },
    );
  } catch {
    // Fallback: rm -rf + prune
    try {
      fs.rmSync(handle.worktreePath, { recursive: true, force: true });
      execSync('git worktree prune', { cwd: handle.originalRepo, timeout: 10_000, stdio: 'pipe' });
    } catch (err) { swallow(err); }
  }
}

/**
 * Lists all git worktrees in the given repo root by parsing
 * `git worktree list --porcelain` output.
 */
export function listWorktrees(cwd: string): Array<{
  path: string; branch: string; head: string; isMain: boolean; isDetached: boolean;
}> {
  try {
    const root = repoRoot(cwd);
    const raw = execSync('git worktree list --porcelain', { cwd: root, timeout: 10_000, stdio: 'pipe' }).toString('utf8');
    const worktrees: Array<{ path: string; branch: string; head: string; isMain: boolean; isDetached: boolean }> = [];
    let current: Partial<{ path: string; branch: string; head: string; isMain: boolean; isDetached: boolean }> = {};
    let firstEntry = true;
    for (const line of raw.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path) worktrees.push(current as any);
        current = { path: line.slice(9).trim(), isMain: firstEntry, isDetached: false };
        firstEntry = false;
      } else if (line.startsWith('HEAD ')) {
        current.head = line.slice(5).trim();
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice(7).trim().replace('refs/heads/', '');
      } else if (line.trim() === 'detached') {
        current.isDetached = true;
        current.branch = current.head?.slice(0, 8) ?? 'detached';
      }
    }
    if (current.path) worktrees.push(current as any);
    return worktrees.map(w => ({ ...w, head: w.head ?? '', branch: w.branch ?? 'unknown' }));
  } catch {
    return [];
  }
}

/**
 * Returns diff stat and name-status between baseRef and the worktree's branch.
 */
export function worktreeDiff(handle: WorktreeHandle, baseRef = 'main'): { stat: string; nameStatus: string } {
  try {
    const stat = execSync(
      `git diff ${baseRef}..${handle.branch} --stat`,
      { cwd: handle.originalRepo, timeout: 15_000, stdio: 'pipe' },
    ).toString('utf8').trim();
    const nameStatus = execSync(
      `git diff ${baseRef}..${handle.branch} --name-status`,
      { cwd: handle.originalRepo, timeout: 15_000, stdio: 'pipe' },
    ).toString('utf8').trim();
    return { stat, nameStatus };
  } catch {
    return { stat: '', nameStatus: '' };
  }
}

export function shouldIsolate(
  dumNumber: string,
  options: { isolate?: boolean; isolateDums?: string },
): boolean {
  if (options.isolate) return true;
  if (options.isolateDums) {
    return options.isolateDums.split(',').map(s => s.trim()).includes(dumNumber);
  }
  return false;
}
