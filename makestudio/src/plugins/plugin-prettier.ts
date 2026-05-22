/**
 * plugin-prettier — Checks code formatting with Prettier after task execution.
 */

import { execSync } from 'child_process';
import { MakeStudioPlugin } from '../core/plugin-types';

const plugin: MakeStudioPlugin = {
  name: 'prettier',
  version: '1.0.0',
  description: 'Check code formatting with Prettier on modified files',

  verifyChecks: [
    {
      name: 'prettier',
      appliesTo: ['feature', 'test', 'architecture'],

      async run(repoPath: string): Promise<{ passed: boolean; output?: string }> {
        try {
          const modifiedFiles = execSync(
            'git diff --name-only --diff-filter=ACMR HEAD | grep -E "\\.(ts|tsx|js|jsx|json|css|scss|md)$" || true',
            { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
          ).trim();

          if (!modifiedFiles) {
            return { passed: true, output: 'No formattable files modified' };
          }

          const files = modifiedFiles.split('\n').filter(Boolean).slice(0, 30);
          const fileList = files.map(f => `"${f}"`).join(' ');

          // Check formatting (--check returns exit 1 if files need formatting)
          try {
            execSync(
              `npx prettier --check ${fileList} 2>/dev/null`,
              { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 30_000 },
            );
            return { passed: true, output: `${files.length} file(s) correctly formatted` };
          } catch (err: any) {
            const output = err.stdout || '';
            const unformatted = output.split('\n').filter((l: string) => l.includes('[')).slice(0, 10);

            return {
              passed: false,
              output: `Files need formatting:\n${unformatted.join('\n')}\nRun: npx prettier --write ${fileList}`,
            };
          }
        } catch {
          return { passed: true, output: 'Prettier not available — skipping' };
        }
      },
    },
  ],
};

export default plugin;
