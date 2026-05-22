import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { swallow } from '../utils/log';
/**
 * Each supported CLI reads its own convention file from the repo root:
 * Claude Code → CLAUDE.md; OpenAI Codex → AGENTS.md; Gemini CLI → GEMINI.md.
 *
 * We pick the right one based on the CLI the agent is about to spawn.
 * That keeps the user's checkout from being polluted by unused siblings
 * (the repo is a real working tree — the developer also works on it).
 */
export type SupportedCLI = 'claude' | 'codex' | 'gemini';

const FILENAME_BY_CLI: Record<SupportedCLI, string> = {
  claude: 'CLAUDE.md',
  codex: 'AGENTS.md',
  gemini: 'GEMINI.md',
};

/** All possible filenames — used for cleanup and for the gitignore registry. */
export const AGENT_CONTEXT_FILENAMES: readonly string[] = Object.values(FILENAME_BY_CLI);

/**
 * Resolve which convention filename a given CLI expects. Unknown CLIs fall
 * back to CLAUDE.md (the most widely adopted convention) so plug-in CLIs
 * that happen to read that file still benefit.
 */
export function resolveContextFilename(cli: string | undefined | null): string {
  if (cli === 'codex') return FILENAME_BY_CLI.codex;
  if (cli === 'gemini') return FILENAME_BY_CLI.gemini;
  return FILENAME_BY_CLI.claude;
}

/**
 * Write the agent-context file to the root of the cloned repository using
 * the convention of the CLI that will actually run the task. Also removes
 * any stale convention files written by a previous task that used a
 * different CLI, so the developer's repo has a single active context file
 * at any time.
 *
 * Writes atomically (temp + rename). The file is added to
 * `.git/info/exclude` so it never lands in commits/PRs.
 */
export function writeAgentContextToRepo(
  repoPath: string,
  content: string | undefined | null,
  cli?: string | null,
): boolean {
  if (!content || !content.trim()) return false;
  if (!repoPath || !fs.existsSync(repoPath)) return false;

  const filename = resolveContextFilename(cli);
  const targetPath = path.join(repoPath, filename);
  const tmpPath = path.join(repoPath, `.${filename}.tmp-${process.pid}`);

  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, targetPath);
  } catch {
    try { fs.unlinkSync(tmpPath); } catch (err) { swallow(err); }
    return false;
  }

  // Remove convention files left behind by a previous run with a different
  // CLI. Keeps the repo root clean and avoids a stale sibling confusing a
  // future manual invocation of the other CLI.
  for (const other of AGENT_CONTEXT_FILENAMES) {
    if (other === filename) continue;
    const orphan = path.join(repoPath, other);
    try { if (fs.existsSync(orphan)) fs.unlinkSync(orphan); } catch (err) { swallow(err); }
  }

  // All three filenames go into .git/info/exclude regardless of which one
  // was written this time — the set of potentially-generated filenames is
  // fixed, and it is safe to pre-ignore siblings that may be written on a
  // future dispatch with a different CLI.
  for (const name of AGENT_CONTEXT_FILENAMES) {
    ensureLocalGitIgnore(repoPath, name);
  }
  return true;
}

/**
 * @deprecated kept for backwards compatibility — prefer
 * {@link writeAgentContextToRepo}. This alias always picks the Claude
 * convention file (CLAUDE.md).
 */
export function writeClaudeMdToRepo(
  repoPath: string,
  claudeMd: string | undefined | null,
): boolean {
  return writeAgentContextToRepo(repoPath, claudeMd, 'claude');
}

/**
 * Append a pattern to `.git/info/exclude` if not already present. This is
 * the git-local ignore file — it is not versioned and does not affect other
 * contributors, unlike `.gitignore`. Silently no-ops for non-git paths.
 */
export function ensureLocalGitIgnore(repoPath: string, pattern: string): void {
  const excludePath = path.join(repoPath, '.git', 'info', 'exclude');
  try {
    if (!fs.existsSync(path.dirname(excludePath))) return; // not a git repo
    let current = '';
    if (fs.existsSync(excludePath)) {
      current = fs.readFileSync(excludePath, 'utf8');
      // Check each non-empty, non-comment line for an exact match.
      const already = current
        .split('\n')
        .map((l) => l.trim())
        .some((l) => l && !l.startsWith('#') && l === pattern);
      if (already) return;
    }
    const prefix = current.length === 0 || current.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(excludePath, `${prefix}${pattern}\n`, 'utf8');
  } catch {
    // Non-critical — the file will just end up committed.
  }
}

// ── Per-branch session tracking ────────────────────────────────────────

/**
 * Small on-disk registry tracking which branches already had a Claude Code
 * session started. The registry lets `buildCLIArgs` decide whether to pass
 * `--continue` (same session, same branch) or start fresh (new branch / new
 * session id).
 *
 * Stored at ~/.makestudio/sessions.json. Keys are `${sessionId}|${branch}`,
 * values are `true` once a session has been started.
 */
const REGISTRY_PATH = path.join(os.homedir(), '.makestudio', 'sessions.json');

function readRegistry(): Record<string, true> {
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeRegistry(data: Record<string, true>): void {
  try {
    fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
    // Atomic write: temp file + rename. Prevents a concurrent task from
    // reading a half-written JSON file if another task is saving at the
    // same time. Node's rename is atomic within the same filesystem.
    const tmp = `${REGISTRY_PATH}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, REGISTRY_PATH);
  } catch {
    // Non-critical — worst case is the agent starts fresh sessions more often.
  }
}

export function sessionKey(sessionId: string | undefined, branch: string | undefined): string | null {
  if (!sessionId || !branch) return null;
  return `${sessionId}|${branch}`;
}

/** Returns true if the session has already been seen on this branch. */
export function hasPriorSession(sessionId: string | undefined, branch: string | undefined): boolean {
  const key = sessionKey(sessionId, branch);
  if (!key) return false;
  const registry = readRegistry();
  return registry[key] === true;
}

/** Mark a (sessionId, branch) pair as seen so the next dispatch continues it. */
export function markSessionStarted(sessionId: string | undefined, branch: string | undefined): void {
  const key = sessionKey(sessionId, branch);
  if (!key) return;
  const registry = readRegistry();
  registry[key] = true;
  // Cap the registry at 500 entries (oldest wins by insertion order).
  const keys = Object.keys(registry);
  if (keys.length > 500) {
    const pruned: Record<string, true> = {};
    for (const k of keys.slice(-500)) pruned[k] = true;
    writeRegistry(pruned);
  } else {
    writeRegistry(registry);
  }
}

/** Clear a session (e.g., when the pipeline finishes). */
export function clearSession(sessionId: string | undefined, branch: string | undefined): void {
  const key = sessionKey(sessionId, branch);
  if (!key) return;
  const registry = readRegistry();
  if (registry[key]) {
    delete registry[key];
    writeRegistry(registry);
  }
}

// ── Repo snapshot ───────────────────────────────────────────────────────

/**
 * Build a short repo snapshot (`git diff --stat` vs develop + top-level
 * directory listing) to prepend to the very first prompt of a session.
 * Gives the CLI a sense of "where I am" without forcing it to explore via
 * Glob/Grep.
 *
 * Returns an empty string if the repo is not a git repository or if the
 * commands fail.
 */
export function buildRepoSnapshot(repoPath: string): string {
  if (!repoPath || !fs.existsSync(path.join(repoPath, '.git'))) return '';
  const { execSync } = require('child_process') as typeof import('child_process');
  const parts: string[] = [];

  // Top-level directory listing (up to 40 entries).
  try {
    const entries = fs
      .readdirSync(repoPath)
      .filter((n) => !n.startsWith('.') || n === '.github' || n === '.claude')
      .slice(0, 40);
    if (entries.length > 0) {
      parts.push('### Repository layout (root)');
      parts.push(entries.map((e) => `- ${e}`).join('\n'));
    }
  } catch {
    // Non-critical
  }

  // Diff stat vs develop (fallback to main) if a reachable base branch exists.
  const base = ['develop', 'main'].find((b) => {
    try {
      execSync(`git rev-parse --verify origin/${b}`, { cwd: repoPath, stdio: 'pipe', timeout: 5_000 });
      return true;
    } catch { return false; }
  });
  if (base) {
    try {
      const diff = execSync(`git diff --stat origin/${base}...HEAD`, {
        cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000,
      }).toString().trim();
      if (diff) {
        parts.push(`### Git diff vs origin/${base}`);
        parts.push('```');
        parts.push(diff.split('\n').slice(0, 40).join('\n'));
        parts.push('```');
      }
    } catch {
      // Non-critical
    }
  }

  if (parts.length === 0) return '';
  return ['## Repo Snapshot', '', ...parts, ''].join('\n');
}
