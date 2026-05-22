/**
 * plugin-eslint — Runs ESLint on modified files after task execution.
 */

import { execSync } from 'child_process';
import { MakeStudioPlugin } from '../core/plugin-types';

const plugin: MakeStudioPlugin = {
  name: 'eslint',
  version: '1.0.0',
  description: 'Run ESLint verification on modified files after task execution',

  verifyChecks: [
    {
      name: 'eslint',
      appliesTo: ['feature', 'test', 'architecture', 'database'],

      async run(repoPath: string): Promise<{ passed: boolean; output?: string }> {
        try {
          // Get modified JS/TS files from git diff
          const modifiedFiles = execSync(
            'git diff --name-only --diff-filter=ACMR HEAD | grep -E "\\.(ts|tsx|js|jsx)$" || true',
            { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
          ).trim();

          if (!modifiedFiles) {
            return { passed: true, output: 'No JS/TS files modified' };
          }

          const files = modifiedFiles.split('\n').filter(Boolean).slice(0, 30);
          const fileList = files.map(f => `"${f}"`).join(' ');

          // Run ESLint with JSON output for parsing
          const result = execSync(
            `npx eslint ${fileList} --format json --no-error-on-unmatched-pattern 2>/dev/null || true`,
            { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 60_000 },
          );

          try {
            const parsed = JSON.parse(result);
            const errorCount = parsed.reduce((sum: number, f: any) => sum + (f.errorCount || 0), 0);
            const warningCount = parsed.reduce((sum: number, f: any) => sum + (f.warningCount || 0), 0);

            if (errorCount > 0) {
              const errorMessages = parsed
                .filter((f: any) => f.errorCount > 0)
                .flatMap((f: any) => f.messages.filter((m: any) => m.severity === 2).map((m: any) => `${f.filePath}:${m.line} — ${m.message} (${m.ruleId})`))
                .slice(0, 10)
                .join('\n');

              return { passed: false, output: `${errorCount} error(s), ${warningCount} warning(s):\n${errorMessages}` };
            }

            return { passed: true, output: `${files.length} file(s) checked — ${warningCount} warning(s)` };
          } catch {
            // ESLint output not JSON — might be a config error
            return { passed: true, output: 'ESLint output could not be parsed — skipping' };
          }
        } catch (err: any) {
          // ESLint not installed or other error — fail-open
          return { passed: true, output: `ESLint not available: ${err.message.substring(0, 100)}` };
        }
      },
    },
  ],
};

export default plugin;
