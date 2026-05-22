/**
 * plugin-git-conventional — Validates commit messages follow Conventional Commits format.
 * Runs before git push and checks all commits on the task branch.
 *
 * Valid formats:
 *   feat: add new feature
 *   fix(auth): resolve login bug
 *   feat!: breaking change
 *   chore(deps): update dependencies
 */

import { execSync } from 'child_process';
import { MakeStudioPlugin } from '../core/plugin-types';

const CONVENTIONAL_PATTERN = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+\))?!?:\s.+/;

const plugin: MakeStudioPlugin = {
  name: 'git-conventional',
  version: '1.0.0',
  description: 'Validate commit messages follow Conventional Commits format before push',

  hooks: {
    async beforeGitPush(info: { repoPath: string; branch: string; taskId: string }): Promise<boolean> {
      try {
        // Get commits on this branch that aren't on develop
        let commits: string;
        try {
          commits = execSync(
            `git log --format="%s" develop..${info.branch} 2>/dev/null`,
            { cwd: info.repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
          ).trim();
        } catch {
          // If develop doesn't exist, check last 5 commits
          commits = execSync(
            `git log --format="%s" -5`,
            { cwd: info.repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
          ).trim();
        }

        if (!commits) return true; // No commits to validate

        const messages = commits.split('\n').filter(Boolean);
        const invalid: string[] = [];

        for (const msg of messages) {
          // Skip merge commits
          if (msg.startsWith('Merge ')) continue;

          if (!CONVENTIONAL_PATTERN.test(msg)) {
            invalid.push(msg);
          }
        }

        if (invalid.length > 0) {
          const { logWarning } = await import('../ui/terminal');
          logWarning(`[git-conventional] ${invalid.length} commit(s) don't follow Conventional Commits:`);
          for (const msg of invalid.slice(0, 5)) {
            logWarning(`  ✗ "${msg}"`);
          }
          logWarning(`  Expected: <type>(<scope>): <description>`);
          logWarning(`  Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert`);

          // Warn but don't block — return true to allow push
          // Set to false if you want to enforce strictly
          return true;
        }

        return true;
      } catch {
        return true; // Fail-open
      }
    },
  },
};

export default plugin;
