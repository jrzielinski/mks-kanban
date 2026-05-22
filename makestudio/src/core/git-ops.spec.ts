import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

import {
  esc,
  validateBranchName,
  isValidBranchName,
  isGitRepo,
  isRepoDirty,
  getCurrentBranch,
  getRepoRemoteUrl,
} from './git-ops';

describe('esc', () => {
  it('wraps the argument in single quotes', () => {
    expect(esc('hello')).toBe("'hello'");
  });

  it('escapes embedded single quotes correctly', () => {
    // The escape pattern is ' → '\'' — closes, escapes literal quote, reopens.
    expect(esc("it's")).toBe("'it'\\''s'");
  });

  it('leaves shell metacharacters inert inside the quotes', () => {
    const out = esc('$(rm -rf /)');
    expect(out).toBe("'$(rm -rf /)'");
    // Quoted — safe for command substitution.
    expect(out.startsWith("'")).toBe(true);
    expect(out.endsWith("'")).toBe(true);
  });

  it('handles empty strings', () => {
    expect(esc('')).toBe("''");
  });
});

describe('validateBranchName / isValidBranchName', () => {
  const valid = [
    'main', 'develop', 'feat/login', 'release-1.2.3',
    'hotfix/urgent.patch', 'dum_003-FEATURE-001',
    'user/alice/feature-x',
  ];
  const invalid = [
    '', ' ', 'has spaces', 'with;semicolon', 'pipe|shell',
    'back`tick`', 'quotes"', "single'quote", '$injection',
    '(parens)', '*glob*', 'a\nb',
  ];

  for (const b of valid) {
    it(`accepts valid branch "${b}"`, () => {
      expect(isValidBranchName(b)).toBe(true);
      validateBranchName(b);
    });
  }

  for (const b of invalid) {
    it(`rejects invalid branch ${JSON.stringify(b)}`, () => {
      expect(isValidBranchName(b)).toBe(false);
      let threw = false;
      try { validateBranchName(b); } catch { threw = true; }
      expect(threw).toBe(true);
    });
  }
});

describe('isGitRepo / isRepoDirty / getCurrentBranch / getRepoRemoteUrl (real git)', () => {
  let repo: string;
  let nonRepo: string;

  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  } as NodeJS.ProcessEnv;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gitops-'));
    nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'nogitops-'));
    execSync('git init -q -b main', { cwd: repo, stdio: 'pipe', env: gitEnv });
    execSync('git config user.email t@example.com', { cwd: repo, stdio: 'pipe', env: gitEnv });
    execSync('git config user.name Test', { cwd: repo, stdio: 'pipe', env: gitEnv });
    execSync('git config commit.gpgsign false', { cwd: repo, stdio: 'pipe', env: gitEnv });
    fs.writeFileSync(path.join(repo, 'file.txt'), 'hello');
    execSync('git add -A', { cwd: repo, stdio: 'pipe', env: gitEnv });
    execSync('git -c commit.gpgsign=false commit -q -m init', { cwd: repo, stdio: 'pipe', env: gitEnv });
  });

  afterEach(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(nonRepo, { recursive: true, force: true }); } catch {}
  });

  it('isGitRepo returns true for a git repo and false otherwise', () => {
    expect(isGitRepo(repo)).toBe(true);
    expect(isGitRepo(nonRepo)).toBe(false);
  });

  it('isRepoDirty returns false on a clean repo', () => {
    expect(isRepoDirty(repo)).toBe(false);
  });

  it('isRepoDirty returns true when an untracked file is present', () => {
    fs.writeFileSync(path.join(repo, 'new.txt'), 'x');
    expect(isRepoDirty(repo)).toBe(true);
  });

  it('isRepoDirty returns true when a tracked file is modified', () => {
    fs.writeFileSync(path.join(repo, 'file.txt'), 'modified');
    expect(isRepoDirty(repo)).toBe(true);
  });

  it('isRepoDirty returns true (defensive) for non-git directories', () => {
    // Callers use this value to decide whether to stash/commit; defaulting to
    // "dirty" when git is not available is the safer side of the coin.
    expect(isRepoDirty(nonRepo)).toBe(true);
  });

  it('getCurrentBranch returns the branch name', () => {
    expect(getCurrentBranch(repo)).toBe('main');
  });

  it('getRepoRemoteUrl returns null when no origin is configured', () => {
    expect(getRepoRemoteUrl(repo)).toBeNull();
  });

  it('getRepoRemoteUrl returns the URL once origin is set', () => {
    execSync('git remote add origin https://github.com/jrzielinski/gptapi.git', { cwd: repo, stdio: 'pipe', env: gitEnv });
    expect(getRepoRemoteUrl(repo)).toBe('https://github.com/jrzielinski/gptapi.git');
  });
});
