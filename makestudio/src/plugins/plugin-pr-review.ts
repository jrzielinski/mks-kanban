import { swallow } from '../utils/log';
/**
 * plugin-pr-review — Generates a PR description summary after task push.
 * Creates a .makestudio/pr-description.md file with structured PR content
 * that can be used when creating pull requests.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { MakeStudioPlugin } from '../core/plugin-types';
import { TaskDispatch, TaskResult } from '../types';

const plugin: MakeStudioPlugin = {
  name: 'pr-review',
  version: '1.0.0',
  description: 'Generate PR description from task execution results',

  hooks: {
    async afterTaskExec(task: TaskDispatch, result: TaskResult): Promise<void> {
      if (!result.gitInfo?.branch || !result.gitInfo?.pushed) return;

      const branch = result.gitInfo.branch;

      try {
        // Find the repo path from task context
        const repoPath = process.cwd(); // Fallback

        // Get commit log for this branch
        let commitLog = '';
        try {
          commitLog = execSync(
            `git log --oneline develop..${branch} 2>/dev/null || git log --oneline -5`,
            { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
          ).trim();
        } catch (err) { swallow(err); }

        // Get changed files summary
        let changedFiles = '';
        try {
          changedFiles = execSync(
            `git diff --stat develop..${branch} 2>/dev/null || git diff --stat HEAD~1`,
            { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
          ).trim();
        } catch (err) { swallow(err); }

        // Build PR description
        const lines: string[] = [
          `## Summary`,
          '',
          `**Task:** ${task.taskTitle || task.taskId}`,
          `**Type:** ${task.taskType || 'feature'}`,
          `**Branch:** \`${branch}\``,
          `**Cost:** $${result.costUsd.toFixed(4)}`,
          '',
        ];

        if (commitLog) {
          lines.push('## Commits', '', '```', commitLog, '```', '');
        }

        if (changedFiles) {
          lines.push('## Changed Files', '', '```', changedFiles, '```', '');
        }

        lines.push(
          '## Test Plan',
          '',
          '- [ ] Code review completed',
          '- [ ] Unit tests pass',
          '- [ ] Integration tests pass',
          '- [ ] Manual testing completed',
          '',
        );

        const prDescPath = path.join(repoPath, '.makestudio', 'pr-description.md');
        fs.mkdirSync(path.dirname(prDescPath), { recursive: true });
        fs.writeFileSync(prDescPath, lines.join('\n'), 'utf8');
      } catch {
        // Non-fatal — PR description generation is best-effort
      }
    },
  },
};

export default plugin;
