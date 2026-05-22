import { execSync } from 'child_process';
import * as fs from 'fs';

jest.mock('child_process', () => ({
  execSync: jest.fn(),
}));

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn(),
    mkdirSync: jest.fn(),
    rmSync: jest.fn(),
  };
});

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
const mockMkdirSync = fs.mkdirSync as jest.MockedFunction<typeof fs.mkdirSync>;
const mockRmSync = fs.rmSync as jest.MockedFunction<typeof fs.rmSync>;

// Default execSync behavior for git commands
const defaultGitResponses: Record<string, string> = {
  'git rev-parse --show-toplevel': '/home/test/repo\n',
  'git symbolic-ref --quiet --short HEAD': 'develop\n',
  'git rev-parse HEAD': 'abc123def456\n',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockExecSync.mockImplementation(((cmd: string) => {
    const key = Object.keys(defaultGitResponses).find(k => cmd.startsWith(k));
    if (key) return defaultGitResponses[key];
    if (cmd.startsWith('git rev-list --count')) return '3\n';
    return '';
  }) as any);
});

describe('repoRoot', () => {
  it('returns the repo root', () => {
    const mod = require('./worktree');
    // Test via canEnterWorktree which calls repoRoot internally
    mockExecSync.mockImplementationOnce(() => '/home/test/repo\n');
    mockExecSync.mockImplementationOnce(() => 'abc123\n');
    const result = mod.canEnterWorktree('/some/path');
    expect(result).toEqual({ ok: true });
  });

  it('throws when not in a git repo', () => {
    const mod = require('./worktree');
    mockExecSync.mockImplementation(() => { throw new Error('fatal: not a git repository'); });
    const result = mod.canEnterWorktree('/some/path');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Not a git repo');
  });
});

describe('currentBranch', () => {
  it('returns the branch name', () => {
    const mod = require('./worktree');
    mockExecSync.mockImplementationOnce(() => '/home/test/repo\n');
    mockExecSync.mockImplementationOnce(() => 'feature/my-branch\n');
    mockExecSync.mockImplementationOnce(() => 'abc123\n');
    const handle = mod.enterWorktreeForDum('/home/test/repo', 'DUM-001');
    expect(handle.originalBranch).toBe('feature/my-branch');
  });

  it('returns null when HEAD is detached', () => {
    const mod = require('./worktree');
    mockExecSync.mockImplementationOnce(() => '/home/test/repo\n');
    mockExecSync.mockImplementationOnce(() => { throw new Error('detached HEAD'); });
    mockExecSync.mockImplementationOnce(() => 'abc123\n');
    mockExistsSync.mockReturnValue(false);
    const handle = mod.enterWorktreeForDum('/home/test/repo', 'DUM-001');
    expect(handle.originalBranch).toBeNull();
  });
});

describe('currentSha', () => {
  it('returns the SHA', () => {
    const mod = require('./worktree');
    mockExecSync.mockImplementationOnce(() => '/home/test/repo\n');
    mockExecSync.mockImplementationOnce(() => 'develop\n');
    mockExecSync.mockImplementationOnce(() => 'def789\n');
    mockExistsSync.mockReturnValue(false);
    const handle = mod.enterWorktreeForDum('/home/test/repo', 'DUM-001');
    expect(handle.baseSha).toBe('def789');
  });
});

describe('dumSlug / worktreePathFor / branchNameFor', () => {
  it('sanitizes DUM number into a branch-safe slug', () => {
    const mod = require('./worktree');
    mockExecSync.mockImplementationOnce(() => '/home/test/repo\n');
    mockExecSync.mockImplementationOnce(() => 'develop\n');
    mockExecSync.mockImplementationOnce(() => 'abc123\n');
    mockExistsSync.mockReturnValue(false);
    const handle = mod.enterWorktreeForDum('/home/test/repo', 'DUM-024');
    expect(handle.branch).toContain('dum-024');
    expect(handle.worktreePath).toContain('dum-024');
  });

  it('handles special characters in DUM number', () => {
    const mod = require('./worktree');
    mockExecSync.mockImplementationOnce(() => '/home/test/repo\n');
    mockExecSync.mockImplementationOnce(() => 'develop\n');
    mockExecSync.mockImplementationOnce(() => 'abc123\n');
    mockExistsSync.mockReturnValue(false);
    const handle = mod.enterWorktreeForDum('/home/test/repo', 'feature/ABC_123!');
    expect(handle.branch).toContain('feature-abc-123-');
  });
});

describe('canEnterWorktree', () => {
  it('returns ok on success', () => {
    const mod = require('./worktree');
    mockExecSync.mockImplementationOnce(() => '/home/test/repo\n');
    mockExecSync.mockImplementationOnce(() => 'abc123\n');
    expect(mod.canEnterWorktree('/some/path')).toEqual({ ok: true });
  });

  it('returns reason on failure', () => {
    const mod = require('./worktree');
    mockExecSync.mockImplementation(() => { throw new Error('Not a git repo'); });
    const result = mod.canEnterWorktree('/bad/path');
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
  });
});

describe('enterWorktreeForDum', () => {
  it('creates a new worktree when dir does not exist', () => {
    const mod = require('./worktree');
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockImplementationOnce(() => '/home/test/repo\n');   // repoRoot
    mockExecSync.mockImplementationOnce(() => 'develop\n');          // currentBranch
    mockExecSync.mockImplementationOnce(() => 'abc123\n');           // currentSha
    mockExecSync.mockImplementationOnce(() => '');                   // not used (fast path skipped)

    const handle = mod.enterWorktreeForDum('/home/test/repo', 'DUM-005');
    expect(handle.worktreePath).toContain('dum-005');
    expect(handle.branch).toBe('dum/dum-005');
    expect(handle.baseSha).toBe('abc123');
    expect(handle.originalRepo).toBe('/home/test/repo');
    expect(handle.originalBranch).toBe('develop');
    expect(mockMkdirSync).toHaveBeenCalled();
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('git worktree add -B "dum/dum-005"'),
      expect.objectContaining({ cwd: '/home/test/repo' }),
    );
  });

  it('reuses existing worktree when dir exists with valid HEAD', () => {
    const mod = require('./worktree');
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementationOnce(() => '/home/test/repo\n');   // repoRoot
    mockExecSync.mockImplementationOnce(() => 'develop\n');           // currentBranch
    mockExecSync.mockImplementationOnce(() => 'abc123\n');           // currentSha (root)
    mockExecSync.mockImplementationOnce(() => 'def456\n');           // HEAD in worktree dir

    const handle = mod.enterWorktreeForDum('/home/test/repo', 'DUM-005');
    expect(handle.worktreePath).toBeDefined();
    // Should NOT call mkdirSync or git worktree add
    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  it('falls through to create when worktree HEAD check throws', () => {
    const mod = require('./worktree');
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementationOnce(() => '/home/test/repo\n');    // repoRoot
    mockExecSync.mockImplementationOnce(() => 'develop\n');            // currentBranch
    mockExecSync.mockImplementationOnce(() => 'abc123\n');            // currentSha
    mockExecSync.mockImplementationOnce(() => { throw new Error('invalid HEAD'); }); // HEAD check fails
    mockExecSync.mockImplementationOnce(() => '');                    // worktree add

    const handle = mod.enterWorktreeForDum('/home/test/repo', 'DUM-005');
    expect(handle).toBeDefined();
    // Should have attempted creation since HEAD check failed
    expect(mockMkdirSync).toHaveBeenCalled();
  });
});

describe('exitWorktreeAndMerge', () => {
  const makeHandle = (overrides?: Record<string, any>) => ({
    worktreePath: '/home/test/repo/.makestudio/worktrees/dum-005',
    branch: 'dum/dum-005',
    baseSha: 'abc123',
    originalRepo: '/home/test/repo',
    originalBranch: 'develop',
    ...overrides,
  });

  it('returns error when originalBranch is null', () => {
    const mod = require('./worktree');
    const result = mod.exitWorktreeAndMerge(makeHandle({ originalBranch: null }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Original branch unknown');
  });

  it('removes worktree with no new commits (aheadCount=0)', () => {
    const mod = require('./worktree');
    mockExecSync.mockImplementationOnce(() => '0\n'); // aheadCount
    mockExecSync.mockImplementationOnce(() => '');   // git worktree remove
    const result = mod.exitWorktreeAndMerge(makeHandle());
    expect(result.ok).toBe(true);
    expect(result.message).toContain('No new commits');
  });

  it('merges when aheadCount > 0', () => {
    const mod = require('./worktree');
    mockExecSync.mockImplementationOnce(() => '3\n'); // aheadCount
    mockExecSync.mockImplementationOnce(() => '');   // git merge
    mockExecSync.mockImplementationOnce(() => '');   // git worktree remove
    const result = mod.exitWorktreeAndMerge(makeHandle());
    expect(result.ok).toBe(true);
    expect(result.message).toContain('Merged');
    expect(result.message).toContain('3 commit');
  });

  it('handles merge failure and aborts', () => {
    const mod = require('./worktree');
    mockExecSync.mockImplementationOnce(() => '3\n'); // aheadCount
    mockExecSync.mockImplementationOnce(() => { throw new Error('Conflict'); }); // merge fails
    mockExecSync.mockImplementationOnce(() => '');   // merge --abort
    const result = mod.exitWorktreeAndMerge(makeHandle());
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Merge falhou');
  });

  it('cleans up worktree after successful merge', () => {
    const mod = require('./worktree');
    mockExecSync.mockImplementationOnce(() => '2\n'); // aheadCount
    mockExecSync.mockImplementationOnce(() => '');   // git merge
    mockExecSync.mockImplementationOnce(() => '');   // git worktree remove
    const result = mod.exitWorktreeAndMerge(makeHandle());
    expect(result.ok).toBe(true);
    // Worktree remove should have been called
    expect(mockExecSync).toHaveBeenLastCalledWith(
      expect.stringContaining('git worktree remove'),
      expect.anything(),
    );
  });

  it('handles aheadCount parse failure as 0', () => {
    const mod = require('./worktree');
    mockExecSync.mockImplementationOnce(() => '');   // aheadCount — empty string
    mockExecSync.mockImplementationOnce(() => '');   // git worktree remove (ahead=0 path)
    const result = mod.exitWorktreeAndMerge(makeHandle());
    expect(result.ok).toBe(true);
    expect(result.message).toContain('No new commits');
  });
});

describe('removeWorktree (via exitWorktreeAndDiscard)', () => {
  const makeHandle = (overrides?: Record<string, any>) => ({
    worktreePath: '/home/test/repo/.makestudio/worktrees/dum-005',
    branch: 'dum/dum-005',
    baseSha: 'abc123',
    originalRepo: '/home/test/repo',
    originalBranch: 'develop',
    ...overrides,
  });

  it('removes worktree and deletes branch', () => {
    const mod = require('./worktree');
    mockExecSync.mockImplementationOnce(() => '');   // git worktree remove
    mockExecSync.mockImplementationOnce(() => '');   // git branch -D
    mod.exitWorktreeAndDiscard(makeHandle());
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('git worktree remove'),
      expect.anything(),
    );
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('git branch -D'),
      expect.anything(),
    );
  });

  it('falls back to rmSync when worktree remove fails', () => {
    const mod = require('./worktree');
    mockExecSync.mockImplementationOnce(() => { throw new Error('remove failed'); });
    mockExecSync.mockImplementationOnce(() => { throw new Error('rm failed'); }); // also make rmSync called
    mockExecSync.mockImplementationOnce(() => '');   // git branch -D
    mod.exitWorktreeAndDiscard(makeHandle());
    expect(mockRmSync).toHaveBeenCalled();
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('git worktree prune'),
      expect.anything(),
    );
  });

  it('handles full cleanup failure gracefully', () => {
    const mod = require('./worktree');
    mockExecSync.mockImplementation(() => { throw new Error('everything fails'); });
    mockRmSync.mockImplementation(() => { throw new Error('rm also fails'); });
    // Should not throw
    expect(() => mod.exitWorktreeAndDiscard(makeHandle())).not.toThrow();
  });
});

describe('shouldIsolate', () => {
  it('returns true when the global --isolate flag is set', () => {
    const mod = require('./worktree');
    expect(mod.shouldIsolate('dum_005', { isolate: true })).toBe(true);
  });

  it('returns true when the DUM number is in the isolateDums list', () => {
    const mod = require('./worktree');
    expect(mod.shouldIsolate('dum_003', { isolateDums: 'dum_001,dum_003,dum_007' })).toBe(true);
  });

  it('trims spaces inside the isolateDums list', () => {
    const mod = require('./worktree');
    expect(mod.shouldIsolate('dum_003', { isolateDums: 'dum_001 , dum_003 , dum_007' })).toBe(true);
  });

  it('returns false when the DUM is not in the list', () => {
    const mod = require('./worktree');
    expect(mod.shouldIsolate('dum_002', { isolateDums: 'dum_001,dum_003' })).toBe(false);
  });

  it('returns false when neither option is set', () => {
    const mod = require('./worktree');
    expect(mod.shouldIsolate('dum_005', {})).toBe(false);
  });

  it('prefers the global --isolate over the list when both are present', () => {
    const mod = require('./worktree');
    expect(mod.shouldIsolate('dum_999', { isolate: true, isolateDums: 'dum_001' })).toBe(true);
  });
});
