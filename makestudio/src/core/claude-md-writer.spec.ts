import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

import {
  writeClaudeMdToRepo,
  writeAgentContextToRepo,
  resolveContextFilename,
  AGENT_CONTEXT_FILENAMES,
  hasPriorSession,
  markSessionStarted,
  clearSession,
  sessionKey,
  buildRepoSnapshot,
  ensureLocalGitIgnore,
} from './claude-md-writer';

// ── Helpers ──────────────────────────────────────────────────────
let tmpDir: string;

function makeTmpRepo(initGit: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudemd-test-'));
  if (initGit) {
    execSync('git init -q', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email test@example.com', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.name Test', { cwd: dir, stdio: 'pipe' });
  }
  return dir;
}

// ── writeClaudeMdToRepo ──────────────────────────────────────────

describe('writeClaudeMdToRepo', () => {
  beforeEach(() => { tmpDir = makeTmpRepo(false); });
  afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

  it('returns false when the content is empty', () => {
    expect(writeClaudeMdToRepo(tmpDir, '')).toBe(false);
    expect(writeClaudeMdToRepo(tmpDir, '   ')).toBe(false);
    expect(writeClaudeMdToRepo(tmpDir, null)).toBe(false);
    expect(writeClaudeMdToRepo(tmpDir, undefined)).toBe(false);
  });

  it('returns false when the repo path does not exist', () => {
    expect(writeClaudeMdToRepo('/nonexistent/path/xyz', 'content')).toBe(false);
  });

  it('writes the file at the repo root', () => {
    const ok = writeClaudeMdToRepo(tmpDir, '# Rules\nBe good.');
    expect(ok).toBe(true);
    const written = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8');
    expect(written).toBe('# Rules\nBe good.');
  });

  it('overwrites an existing CLAUDE.md atomically', () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), 'old content');
    writeClaudeMdToRepo(tmpDir, 'new content');
    const written = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8');
    expect(written).toBe('new content');
    // No leftover tmp files
    const entries = fs.readdirSync(tmpDir).filter((n) => n.startsWith('.CLAUDE.md.tmp'));
    expect(entries).toEqual([]);
  });
});

describe('resolveContextFilename', () => {
  it('maps each known CLI to its own convention file', () => {
    expect(resolveContextFilename('claude')).toBe('CLAUDE.md');
    expect(resolveContextFilename('codex')).toBe('AGENTS.md');
    expect(resolveContextFilename('gemini')).toBe('GEMINI.md');
  });

  it('falls back to CLAUDE.md for unknown or empty CLIs', () => {
    expect(resolveContextFilename(undefined)).toBe('CLAUDE.md');
    expect(resolveContextFilename(null)).toBe('CLAUDE.md');
    expect(resolveContextFilename('')).toBe('CLAUDE.md');
    expect(resolveContextFilename('aider')).toBe('CLAUDE.md');
  });
});

describe('writeAgentContextToRepo (CLI-aware)', () => {
  let gitRepo: string;
  beforeEach(() => { gitRepo = makeTmpRepo(true); });
  afterEach(() => { try { fs.rmSync(gitRepo, { recursive: true, force: true }); } catch {} });

  it('writes only CLAUDE.md when cli=claude', () => {
    writeAgentContextToRepo(gitRepo, 'body', 'claude');
    expect(fs.existsSync(path.join(gitRepo, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(gitRepo, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(gitRepo, 'GEMINI.md'))).toBe(false);
  });

  it('writes only AGENTS.md when cli=codex', () => {
    writeAgentContextToRepo(gitRepo, 'body', 'codex');
    expect(fs.existsSync(path.join(gitRepo, 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(gitRepo, 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(gitRepo, 'GEMINI.md'))).toBe(false);
  });

  it('writes only GEMINI.md when cli=gemini', () => {
    writeAgentContextToRepo(gitRepo, 'body', 'gemini');
    expect(fs.existsSync(path.join(gitRepo, 'GEMINI.md'))).toBe(true);
    expect(fs.existsSync(path.join(gitRepo, 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(gitRepo, 'AGENTS.md'))).toBe(false);
  });

  it('removes stale sibling convention files when the CLI changes', () => {
    // Simulate a previous run that used Claude
    fs.writeFileSync(path.join(gitRepo, 'CLAUDE.md'), 'stale');
    writeAgentContextToRepo(gitRepo, 'fresh', 'codex');
    expect(fs.existsSync(path.join(gitRepo, 'CLAUDE.md'))).toBe(false);
    expect(fs.readFileSync(path.join(gitRepo, 'AGENTS.md'), 'utf8')).toBe('fresh');
  });

  it('pre-registers all three filenames in .git/info/exclude', () => {
    writeAgentContextToRepo(gitRepo, 'body', 'gemini');
    const exclRaw = fs.readFileSync(path.join(gitRepo, '.git', 'info', 'exclude'), 'utf8');
    const lines = exclRaw.split('\n').map((l) => l.trim());
    for (const name of AGENT_CONTEXT_FILENAMES) {
      expect(lines).toContain(name);
    }
  });

  it('returns false on empty content and writes no file', () => {
    expect(writeAgentContextToRepo(gitRepo, '', 'claude')).toBe(false);
    expect(writeAgentContextToRepo(gitRepo, null, 'claude')).toBe(false);
    expect(writeAgentContextToRepo(gitRepo, undefined, 'claude')).toBe(false);
    expect(fs.existsSync(path.join(gitRepo, 'CLAUDE.md'))).toBe(false);
  });

  it('falls back to CLAUDE.md when cli is not provided', () => {
    writeAgentContextToRepo(gitRepo, 'body');
    expect(fs.existsSync(path.join(gitRepo, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(gitRepo, 'AGENTS.md'))).toBe(false);
  });

  it('writeClaudeMdToRepo alias writes only CLAUDE.md', () => {
    expect(writeClaudeMdToRepo(gitRepo, 'legacy')).toBe(true);
    expect(fs.existsSync(path.join(gitRepo, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(gitRepo, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(gitRepo, 'GEMINI.md'))).toBe(false);
  });
});

describe('ensureLocalGitIgnore (via writeClaudeMdToRepo)', () => {
  let gitRepo: string;
  beforeEach(() => { gitRepo = makeTmpRepo(true); });
  afterEach(() => { try { fs.rmSync(gitRepo, { recursive: true, force: true }); } catch {} });

  it('adds CLAUDE.md to .git/info/exclude when writing to a git repo', () => {
    writeClaudeMdToRepo(gitRepo, '# content');
    const excludeRaw = fs.readFileSync(path.join(gitRepo, '.git', 'info', 'exclude'), 'utf8');
    expect(excludeRaw.split('\n').map((l) => l.trim())).toContain('CLAUDE.md');
  });

  it('does not duplicate the entry across multiple writes', () => {
    writeClaudeMdToRepo(gitRepo, 'first');
    writeClaudeMdToRepo(gitRepo, 'second');
    writeClaudeMdToRepo(gitRepo, 'third');
    const excludeRaw = fs.readFileSync(path.join(gitRepo, '.git', 'info', 'exclude'), 'utf8');
    const occurrences = excludeRaw.split('\n').filter((l) => l.trim() === 'CLAUDE.md').length;
    expect(occurrences).toBe(1);
  });

  it('preserves existing entries in .git/info/exclude', () => {
    const exclPath = path.join(gitRepo, '.git', 'info', 'exclude');
    fs.writeFileSync(exclPath, '# existing\n*.log\n');
    writeClaudeMdToRepo(gitRepo, 'x');
    const excludeRaw = fs.readFileSync(exclPath, 'utf8');
    expect(excludeRaw).toContain('# existing');
    expect(excludeRaw).toContain('*.log');
    expect(excludeRaw).toContain('CLAUDE.md');
  });

  it('no-ops on non-git directories (no exclude file written)', () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'nongit-'));
    try {
      ensureLocalGitIgnore(nonGit, 'CLAUDE.md');
      expect(fs.existsSync(path.join(nonGit, '.git'))).toBe(false);
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });
});

// ── other describes share the tmpDir via the setup helpers below
// (kept here so unused top-level tmpDir lint warnings don't fire in jest).

// ── sessionKey ────────────────────────────────────────────────────

describe('sessionKey', () => {
  it('returns null when either argument is missing', () => {
    expect(sessionKey(undefined, 'b')).toBeNull();
    expect(sessionKey('s', undefined)).toBeNull();
    expect(sessionKey(undefined, undefined)).toBeNull();
  });

  it('returns a pipe-separated key when both present', () => {
    expect(sessionKey('pipeline:dum_003', 'dum_003-FEATURE')).toBe('pipeline:dum_003|dum_003-FEATURE');
  });
});

// ── session registry ─────────────────────────────────────────────

describe('hasPriorSession / markSessionStarted / clearSession', () => {
  const sid = `test-sid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const br = 'feat/test';

  afterEach(() => { clearSession(sid, br); });

  it('returns false before the session is marked', () => {
    expect(hasPriorSession(sid, br)).toBe(false);
  });

  it('returns true after marking, false after clearing', () => {
    markSessionStarted(sid, br);
    expect(hasPriorSession(sid, br)).toBe(true);
    clearSession(sid, br);
    expect(hasPriorSession(sid, br)).toBe(false);
  });

  it('returns false for missing sessionId or branch even after marking', () => {
    markSessionStarted(sid, br);
    expect(hasPriorSession(undefined, br)).toBe(false);
    expect(hasPriorSession(sid, undefined)).toBe(false);
  });
});

// ── buildRepoSnapshot ─────────────────────────────────────────────

describe('buildRepoSnapshot', () => {
  beforeEach(() => { tmpDir = makeTmpRepo(false); });
  afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

  it('returns empty string for non-git directories', () => {
    const snap = buildRepoSnapshot(tmpDir);
    expect(snap).toBe('');
  });

  it('returns a snapshot for a valid git repo with files', () => {
    const gitDir = makeTmpRepo(true);
    try {
      fs.writeFileSync(path.join(gitDir, 'README.md'), '# Test');
      fs.writeFileSync(path.join(gitDir, 'package.json'), '{}');
      fs.mkdirSync(path.join(gitDir, 'src'));
      const snap = buildRepoSnapshot(gitDir);
      expect(snap).toContain('## Repo Snapshot');
      expect(snap).toContain('Repository layout');
      expect(snap).toContain('README.md');
      expect(snap).toContain('package.json');
      expect(snap).toContain('src');
    } finally {
      fs.rmSync(gitDir, { recursive: true, force: true });
    }
  });

  it('returns empty string when repo path is missing', () => {
    expect(buildRepoSnapshot('')).toBe('');
    expect(buildRepoSnapshot('/definitely/does/not/exist')).toBe('');
  });
});
