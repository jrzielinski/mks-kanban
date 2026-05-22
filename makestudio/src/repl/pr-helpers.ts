/**
 * pr-helpers.ts — GitHub CLI wrappers for the IPC layer.
 *
 * All operations use execFileSync/execFile with argument arrays (no shell).
 * Credentials come from `gh auth login`; this module never handles tokens.
 */

import { execFileSync, execSync } from 'child_process';
import type { PullRequestDTO, PRCommentDTO, PRCreateRequestDTO } from './ipc/types';

interface GhPreflight {
  ok: boolean;
  error?: string;
}

const _preflight: Map<string, { ts: number; result: GhPreflight }> = new Map();
const PREFLIGHT_TTL_MS = 60_000;

/** Check gh CLI availability + auth status, with TTL cache. */
export async function ghPreflightAsync(cwd: string): Promise<GhPreflight> {
  const cached = _preflight.get(cwd);
  if (cached && Date.now() - cached.ts < PREFLIGHT_TTL_MS) return cached.result;

  const cache = (result: GhPreflight) => { _preflight.set(cwd, { ts: Date.now(), result }); return result; };

  try {
    execFileSync('gh', ['--version'], { stdio: 'pipe', timeout: 5_000 });
  } catch {
    return cache({ ok: false, error: '`gh` CLI not found. Install from https://cli.github.com' });
  }

  try {
    execFileSync('gh', ['auth', 'status'], { cwd, stdio: 'pipe', timeout: 10_000 });
  } catch {
    return cache({ ok: false, error: 'Not authenticated with GitHub. Run `gh auth login`.' });
  }

  try {
    execSync('git rev-parse --show-toplevel', { cwd, stdio: 'pipe', timeout: 5_000 });
  } catch {
    return cache({ ok: false, error: 'Not inside a git repository.' });
  }

  return cache({ ok: true });
}

function parseGhJson<T>(json: string): T | null {
  try { return JSON.parse(json); } catch { return null; }
}

const PR_FIELDS = 'number,title,state,author,url,body,mergedAt,closedAt,createdAt,isDraft,headRefName,baseRefName';

function mapPr(p: any): PullRequestDTO {
  return {
    number: p.number,
    title: p.title ?? '',
    state: p.state ?? 'OPEN',
    author: p.author?.login ?? p.author ?? '',
    url: p.url ?? '',
    body: p.body,
    mergedAt: p.mergedAt,
    closedAt: p.closedAt,
    createdAt: p.createdAt ?? '',
    draft: p.isDraft ?? false,
    headRef: p.headRefName,
    baseRef: p.baseRefName,
  };
}

export function listPRs(cwd: string, state: 'open' | 'closed' | 'merged' | 'all' = 'open'): PullRequestDTO[] {
  try {
    const raw = execFileSync('gh', [
      'pr', 'list',
      '--state', state === 'all' ? 'all' : state,
      '--json', PR_FIELDS,
      '--limit', '50',
    ], { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 30_000 });
    const list = parseGhJson<any[]>(raw);
    return (list ?? []).map(mapPr);
  } catch {
    return [];
  }
}

export function viewPR(cwd: string, num: number): PullRequestDTO | null {
  try {
    const raw = execFileSync('gh', ['pr', 'view', String(num), '--json', PR_FIELDS],
      { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 15_000 });
    const p = parseGhJson<any>(raw);
    return p ? mapPr(p) : null;
  } catch {
    return null;
  }
}

export function listPRComments(cwd: string, num: number): PRCommentDTO[] {
  try {
    const raw = execFileSync('gh', [
      'api', `repos/{owner}/{repo}/pulls/${num}/comments`,
      '--jq', '.[] | {path: .path, line: .line, author: .user.login, body: .body, createdAt: .created_at}',
    ], { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 20_000 });
    return raw.trim().split('\n').filter(Boolean).map((line) => {
      const c = parseGhJson<any>(line);
      return { path: c?.path, line: c?.line, author: c?.author ?? '', body: c?.body ?? '', createdAt: c?.createdAt ?? '' };
    });
  } catch {
    return [];
  }
}

export function createPR(cwd: string, args: PRCreateRequestDTO): PullRequestDTO {
  const flags = ['pr', 'create', '--title', args.title, '--body', args.body, '--base', args.base];
  if (args.draft) flags.push('--draft');
  const raw = execFileSync('gh', flags, { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 60_000 });
  // Output is the PR URL (last non-empty line)
  const lines = raw.trim().split('\n').filter(Boolean);
  const url = lines[lines.length - 1] ?? '';
  const m = url.match(/\/pull\/(\d+)/);
  if (!m) throw new Error(`gh pr create returned unexpected output: ${raw.slice(0, 200)}`);
  const num = parseInt(m[1], 10);
  return { number: num, title: args.title, state: 'OPEN', author: '', url, body: args.body, createdAt: new Date().toISOString() };
}
