import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  createSubagentWorktree,
  removeSubagentWorktree,
  wantsWorktreeIsolation,
  summariseWorktree,
} from './subagent-worktree';

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-wt-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  execSync('git add .', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m initial', { cwd: dir, stdio: 'pipe' });
  return dir;
}

describe('subagent-worktree', () => {
  describe('wantsWorktreeIsolation', () => {
    it('honours explicit isolation field', () => {
      expect(wantsWorktreeIsolation({ isolation: 'worktree' })).toBe(true);
    });

    it('honours legacy boolean shorthand', () => {
      expect(wantsWorktreeIsolation({ worktree: true })).toBe(true);
    });

    it('returns false otherwise', () => {
      expect(wantsWorktreeIsolation({})).toBe(false);
      expect(wantsWorktreeIsolation({ isolation: 'shared' })).toBe(false);
      expect(wantsWorktreeIsolation(null)).toBe(false);
    });
  });

  describe('createSubagentWorktree / removeSubagentWorktree', () => {
    let repo: string;

    beforeEach(() => {
      repo = makeTempRepo();
    });

    afterEach(() => {
      try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* */ }
    });

    it('creates a worktree at a sibling path with a unique branch', () => {
      const handle = createSubagentWorktree(repo, 'my-investigation');
      expect(fs.existsSync(handle.path)).toBe(true);
      expect(handle.branch).toMatch(/^subagent\/my-investigation-/);
      expect(handle.originalRoot).toBe(execSync('git rev-parse --show-toplevel', { cwd: repo }).toString().trim());

      // Worktree contains the README from the base branch
      expect(fs.existsSync(path.join(handle.path, 'README.md'))).toBe(true);

      removeSubagentWorktree(handle);
      expect(fs.existsSync(handle.path)).toBe(false);
    });

    it('sanitises slug to safe filename + branch chars', () => {
      const handle = createSubagentWorktree(repo, 'foo/bar baz!');
      expect(handle.branch).not.toContain(' ');
      expect(handle.branch).not.toContain('!');
      // Slug "foo/bar baz!" gets cleaned of /, space, ! → "foo-bar-baz-"
      expect(handle.branch).toMatch(/foo-bar-baz/);
      removeSubagentWorktree(handle);
    });

    it('isolates edits — changes in worktree do not appear in base', () => {
      const handle = createSubagentWorktree(repo, 'edit-test');
      fs.writeFileSync(path.join(handle.path, 'newfile.txt'), 'subagent wrote this');

      // Base repo's working tree should not see the new file.
      expect(fs.existsSync(path.join(repo, 'newfile.txt'))).toBe(false);

      removeSubagentWorktree(handle);
    });

    it('removeSubagentWorktree drops the branch by default', () => {
      const handle = createSubagentWorktree(repo, 'branch-cleanup');
      removeSubagentWorktree(handle);
      const branches = execSync('git branch', { cwd: repo }).toString();
      expect(branches).not.toContain(handle.branch);
    });

    it('keepBranch=true preserves the branch', () => {
      const handle = createSubagentWorktree(repo, 'keep-branch');
      removeSubagentWorktree(handle, true);
      const branches = execSync('git branch', { cwd: repo }).toString();
      expect(branches).toContain(handle.branch);
    });

    it('throws when called outside a git repo', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'no-repo-'));
      try {
        expect(() => createSubagentWorktree(tmp, 'x')).toThrow(/not inside a git repo/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('summariseWorktree', () => {
    it('returns empty string when no handle', () => {
      expect(summariseWorktree(null, false)).toBe('');
    });

    it('mentions retain when kept=true', () => {
      const out = summariseWorktree({ path: '/x', branch: 'b', originalRoot: '/r' }, true);
      expect(out).toContain('worktree retained');
      expect(out).toContain('git -C /r diff');
    });

    it('mentions discard when kept=false', () => {
      const out = summariseWorktree({ path: '/x', branch: 'b', originalRoot: '/r' }, false);
      expect(out).toContain('discarded');
    });
  });
});
