import { execSync, execFileSync } from 'child_process';
import type { GitStatusDTO, GitFileChangeDTO, GitBranchDTO, GitDiffDTO, GitCommitResultDTO } from '../repl/ipc/types';

import { swallow } from '../utils/log';
function git(cwd: string, args: string[], timeout = 15_000): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', timeout }).trim();
}

/** Escape a string for safe use in shell commands (single-quote wrapping) */
export function esc(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Validate branch name against a conservative safe pattern. Rejects anything
 * that could be interpreted by the shell or introduce git surprises (spaces,
 * quotes, command substitution, etc.). Kept exported so callers outside
 * this file — and unit tests — can reuse it.
 */
export function validateBranchName(branch: string): void {
  if (!/^[a-zA-Z0-9._\/-]+$/.test(branch)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }
}

/** Boolean variant of validateBranchName that never throws. */
export function isValidBranchName(branch: string): boolean {
  return /^[a-zA-Z0-9._\/-]+$/.test(branch);
}

export function isGitRepo(repoPath: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

export function isRepoDirty(repoPath: string): boolean {
  try {
    const status = execSync('git status --porcelain', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    return status.length > 0;
  } catch {
    return true;
  }
}

export function getCurrentBranch(repoPath: string): string {
  return execSync('git rev-parse --abbrev-ref HEAD', {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}

export function checkoutBranch(repoPath: string, branch: string, createNew: boolean = true): void {
  validateBranchName(branch);
  try {
    // Check if branch exists
    execSync(`git rev-parse --verify ${esc(branch)}`, {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    // Branch exists, just checkout
    execSync(`git checkout ${esc(branch)}`, {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch {
    if (createNew) {
      // Create and checkout new branch
      execSync(`git checkout -b ${esc(branch)}`, {
        cwd: repoPath,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } else {
      throw new Error(`Branch ${branch} não encontrada`);
    }
  }
}

export function commitAll(repoPath: string, message: string): number {
  // Check if there are changes to commit
  const status = execSync('git status --porcelain', {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();

  if (!status) return 0;

  execSync('git add -A', {
    cwd: repoPath,
    stdio: 'pipe',
  });

  execSync(`git commit -m ${esc(message)}`, {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  // Count commits on branch vs origin
  try {
    const count = execSync('git rev-list --count HEAD ^origin/HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    return parseInt(count, 10) || 1;
  } catch {
    return 1;
  }
}

export function pushBranch(repoPath: string, branch: string): boolean {
  validateBranchName(branch);
  try {
    execSync(`git push origin ${esc(branch)} --force-with-lease`, {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 60_000,
    });
    return true;
  } catch (err: any) {
    console.error(`Push failed: ${err.message}`);
    return false;
  }
}

export function fetchOrigin(repoPath: string): void {
  try {
    execSync('git fetch origin', {
      cwd: repoPath,
      stdio: 'pipe',
      timeout: 30_000,
    });
  } catch {
    // Non-fatal
  }
}

export function getRepoRemoteUrl(repoPath: string): string | null {
  try {
    return execSync('git remote get-url origin', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  } catch {
    return null;
  }
}

// ── IPC-friendly helpers (execFileSync, no shell) ─────────────────────────

/** Parse `git status --porcelain=v2 --branch` into a typed DTO. */
export function gitStatus(cwd: string): GitStatusDTO {
  let branchLine = '';
  let ahead = 0;
  let behind = 0;
  const files: GitFileChangeDTO[] = [];

  try {
    const raw = git(cwd, ['status', '--porcelain=v2', '--branch']);
    for (const line of raw.split('\n')) {
      if (line.startsWith('# branch.head ')) {
        branchLine = line.slice('# branch.head '.length).trim();
      } else if (line.startsWith('# branch.ab ')) {
        const m = line.match(/\+(\d+)\s+-(\d+)/);
        if (m) { ahead = parseInt(m[1], 10); behind = parseInt(m[2], 10); }
      } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
        const parts = line.split(' ');
        const xy = parts[1] ?? '..';
        const staged = xy[0] !== '.' && xy[0] !== '?';
        const unstaged = xy[1] !== '.' && xy[1] !== '?';
        const filePath = parts.slice(8).join(' ');
        const statusChar = (staged ? xy[0] : xy[1]) as GitFileChangeDTO['status'];
        if (staged) files.push({ path: filePath, status: statusChar, staged: true });
        if (unstaged && !staged) files.push({ path: filePath, status: statusChar, staged: false });
        if (unstaged && staged) files.push({ path: filePath, status: xy[1] as GitFileChangeDTO['status'], staged: false });
      } else if (line.startsWith('? ')) {
        files.push({ path: line.slice(2).trim(), status: '?', staged: false });
      }
    }
  } catch (err) { swallow(err); }

  return {
    branch: branchLine || 'HEAD',
    dirty: files.length > 0,
    ahead,
    behind,
    files,
    remoteUrl: getRepoRemoteUrl(cwd) ?? undefined,
  };
}

/** Returns raw diff output, truncated to maxBytes (default 100 KB). */
export function gitDiff(cwd: string, opts: { path?: string; staged?: boolean; baseRef?: string; maxBytes?: number } = {}): GitDiffDTO {
  const MAX = opts.maxBytes ?? 100_000;
  const args = ['diff', '--no-color'];
  if (opts.staged) args.push('--staged');
  if (opts.baseRef) args.push(opts.baseRef);
  if (opts.path) args.push('--', opts.path);
  try {
    const raw = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 30_000, maxBuffer: 5 * 1024 * 1024 });
    const ins = (raw.match(/^\+[^+]/gm) ?? []).length;
    const del = (raw.match(/^-[^-]/gm) ?? []).length;
    const truncated = raw.length > MAX;
    return { raw: truncated ? raw.slice(0, MAX) + '\n... [truncated]' : raw, insertions: ins, deletions: del, truncated };
  } catch {
    return { raw: '', insertions: 0, deletions: 0, truncated: false };
  }
}

/** List local + remote branches with last commit info. */
export function listBranches(cwd: string): GitBranchDTO[] {
  try {
    const raw = git(cwd, ['branch', '-a', '--sort=-committerdate', '--format=%(refname:short)\t%(HEAD)\t%(objectname:short)\t%(subject)\t%(committerdate:iso)']);
    return raw.split('\n').filter(Boolean).slice(0, 30).map((line) => {
      const [name = '', head = '', sha = '', message = '', date = ''] = line.split('\t');
      return {
        name: name.replace(/^remotes\//, ''),
        current: head === '*',
        remote: name.startsWith('remotes/') ? name : undefined,
        lastCommit: sha ? { sha, message, date } : undefined,
      };
    });
  } catch {
    return [];
  }
}

/** Stage all changes, commit, and return result. */
export function commitAllFiles(cwd: string, message: string): GitCommitResultDTO {
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 }).trim();
  if (!dirty) throw new Error('Nothing to commit — working tree is clean');
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-m', message], 30_000);
  const sha = git(cwd, ['rev-parse', '--short', 'HEAD']);
  let filesChanged = 0;
  try {
    const stat = git(cwd, ['diff', '--shortstat', 'HEAD~1', 'HEAD']);
    const m = stat.match(/(\d+) file/);
    if (m) filesChanged = parseInt(m[1], 10);
  } catch (err) { swallow(err); }
  return { sha, message, filesChanged };
}
