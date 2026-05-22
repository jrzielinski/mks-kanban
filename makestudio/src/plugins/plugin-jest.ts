/**
 * plugin-jest — Runs Jest tests on modified test files after task execution.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { MakeStudioPlugin } from '../core/plugin-types';

const plugin: MakeStudioPlugin = {
  name: 'jest',
  version: '1.0.0',
  description: 'Run Jest tests related to modified files after task execution',

  verifyChecks: [
    {
      name: 'jest',
      appliesTo: ['feature', 'test'],

      async run(repoPath: string, taskType?: string): Promise<{ passed: boolean; output?: string }> {
        // Check if Jest is available
        const pkgJsonPath = path.join(repoPath, 'package.json');
        if (!fs.existsSync(pkgJsonPath)) {
          return { passed: true, output: 'No package.json found' };
        }

        try {
          const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
          const hasJest = pkgJson.devDependencies?.jest || pkgJson.dependencies?.jest ||
                          pkgJson.devDependencies?.['@jest/core'] || pkgJson.scripts?.test?.includes('jest');

          if (!hasJest) {
            return { passed: true, output: 'Jest not configured in this project' };
          }
        } catch {
          return { passed: true, output: 'Could not read package.json' };
        }

        try {
          // For test tasks, run all tests; for feature tasks, run related tests only
          let testCommand: string;

          if (taskType === 'test') {
            testCommand = 'npx jest --passWithNoTests --ci --forceExit 2>&1';
          } else {
            // Get modified files and find related test files
            const modifiedFiles = execSync(
              'git diff --name-only --diff-filter=ACMR HEAD | grep -E "\\.(ts|tsx|js|jsx)$" || true',
              { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
            ).trim();

            if (!modifiedFiles) {
              return { passed: true, output: 'No JS/TS files modified' };
            }

            // Run Jest with --findRelatedTests for targeted testing
            const files = modifiedFiles.split('\n').filter(Boolean).slice(0, 20);
            const fileList = files.map(f => `"${f}"`).join(' ');
            testCommand = `npx jest --findRelatedTests ${fileList} --passWithNoTests --ci --forceExit 2>&1`;
          }

          const output = execSync(testCommand, {
            cwd: repoPath,
            encoding: 'utf8',
            stdio: 'pipe',
            timeout: 180_000, // 3 minutes
          });

          // Parse test summary
          const summaryMatch = output.match(/Tests:\s+(.+)/);
          const summary = summaryMatch?.[1] || 'Tests passed';

          return { passed: true, output: summary };
        } catch (err: any) {
          const output = err.stdout || err.message || '';
          // Extract failure summary
          const failMatch = output.match(/Tests:\s+(.+)/);
          const summary = failMatch?.[1] || output.substring(0, 500);

          return { passed: false, output: `Tests failed: ${summary}` };
        }
      },
    },
  ],
};

export default plugin;
