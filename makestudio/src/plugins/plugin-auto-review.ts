import { swallow } from '../utils/log';
/**
 * plugin-auto-review — Auto-generates code review after task push.
 * Reviews the diff and creates a structured review in .makestudio/review.md
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { MakeStudioPlugin } from '../core/plugin-types';
import { TaskDispatch, TaskResult } from '../types';

const plugin: MakeStudioPlugin = {
  name: 'auto-review',
  version: '1.0.0',
  description: 'Auto-generate code review checklist after task push',

  hooks: {
    async afterTaskExec(task: TaskDispatch, result: TaskResult): Promise<void> {
      if (!result.gitInfo?.branch || !result.gitInfo?.pushed) return;

      try {
        const repoPath = process.cwd();
        const branch = result.gitInfo.branch;

        // Get the diff
        let diff = '';
        try {
          diff = execSync(
            `git diff develop..${branch} --stat 2>/dev/null || git diff HEAD~1 --stat`,
            { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 15_000 },
          ).trim();
        } catch (err) { swallow(err); }

        // Get full diff for analysis
        let fullDiff = '';
        try {
          fullDiff = execSync(
            `git diff develop..${branch} 2>/dev/null || git diff HEAD~1`,
            { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 15_000 },
          ).trim().substring(0, 50_000); // Cap at 50KB
        } catch (err) { swallow(err); }

        // Analyze the diff
        const addedLines = (fullDiff.match(/^\+[^+]/gm) || []).length;
        const removedLines = (fullDiff.match(/^-[^-]/gm) || []).length;
        const modifiedFiles = diff.split('\n').filter(l => l.includes('|')).length;

        // Detect potential issues
        const issues: string[] = [];

        // Check for TODO/FIXME/HACK
        const todoMatches = fullDiff.match(/\+.*(?:TODO|FIXME|HACK|XXX).*$/gm) || [];
        if (todoMatches.length > 0) {
          issues.push(`${todoMatches.length} TODO/FIXME/HACK comment(s) added`);
        }

        // Check for console.log
        const consoleLogs = (fullDiff.match(/\+.*console\.log\(/g) || []).length;
        if (consoleLogs > 0) {
          issues.push(`${consoleLogs} console.log() added`);
        }

        // Check for any() type
        const anyTypes = (fullDiff.match(/\+.*:\s*any\b/g) || []).length;
        if (anyTypes > 3) {
          issues.push(`${anyTypes} 'any' type annotations added — consider proper typing`);
        }

        // Check for large functions (heuristic: many consecutive + lines)
        const longAdditions = fullDiff.split('\n').reduce((acc, line) => {
          if (line.startsWith('+') && !line.startsWith('+++')) {
            acc.current++;
            acc.max = Math.max(acc.max, acc.current);
          } else {
            acc.current = 0;
          }
          return acc;
        }, { current: 0, max: 0 });

        if (longAdditions.max > 100) {
          issues.push(`Large block of ${longAdditions.max} consecutive added lines — consider splitting`);
        }

        // Check for hardcoded strings
        const hardcodedStrings = (fullDiff.match(/\+.*['"](?:http|https|localhost|127\.0\.0\.1)[^'"]+['"]/g) || []).length;
        if (hardcodedStrings > 0) {
          issues.push(`${hardcodedStrings} hardcoded URL(s) found — consider using env vars`);
        }

        // Build review
        const lines: string[] = [
          `# Code Review: ${task.taskTitle || task.taskId}`,
          '',
          `**Branch:** \`${branch}\``,
          `**Type:** ${task.taskType || 'feature'}`,
          `**Files:** ${modifiedFiles} | **Added:** +${addedLines} | **Removed:** -${removedLines}`,
          '',
          '## Summary',
          '',
          diff,
          '',
        ];

        if (issues.length > 0) {
          lines.push('## Issues Found', '');
          for (const issue of issues) {
            lines.push(`- [ ] ${issue}`);
          }
          lines.push('');
        } else {
          lines.push('## No Issues Found', '', 'Code looks clean. Standard review checklist:', '');
        }

        lines.push(
          '## Review Checklist',
          '',
          '- [ ] Code follows project conventions',
          '- [ ] No hardcoded secrets or credentials',
          '- [ ] Error handling is appropriate',
          '- [ ] Multi-tenant: queries filter by tenantId',
          '- [ ] No memory leaks (cleanup intervals, close connections)',
          '- [ ] Tests cover the changes',
          '',
        );

        const reviewPath = path.join(repoPath, '.makestudio', 'review.md');
        fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
        fs.writeFileSync(reviewPath, lines.join('\n'), 'utf8');
      } catch (err) { swallow(err); }
    },
  },
};

export default plugin;
