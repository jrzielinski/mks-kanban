/**
 * plugin-dead-code — Detects unused exports using ts-prune.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { MakeStudioPlugin } from '../core/plugin-types';

const plugin: MakeStudioPlugin = {
  name: 'dead-code',
  version: '1.0.0',
  description: 'Detect unused exports (dead code) in modified files',

  verifyChecks: [
    {
      name: 'dead-code',
      appliesTo: ['feature', 'architecture'],

      async run(repoPath: string): Promise<{ passed: boolean; output?: string }> {
        if (!fs.existsSync(path.join(repoPath, 'tsconfig.json'))) {
          return { passed: true, output: 'No tsconfig.json — skipping' };
        }

        try {
          // Get modified files
          const modifiedFiles = execSync(
            'git diff --name-only --diff-filter=ACMR HEAD | grep -E "\\.tsx?$" || true',
            { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
          ).trim().split('\n').filter(Boolean);

          if (!modifiedFiles.length) {
            return { passed: true, output: 'No TypeScript files modified' };
          }

          const result = execSync(
            'npx ts-prune 2>/dev/null || echo ""',
            { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 60_000 },
          ).trim();

          if (!result) {
            return { passed: true, output: 'ts-prune not available or no issues found' };
          }

          // Filter to only modified files
          const relevantIssues = result.split('\n').filter(line => {
            return modifiedFiles.some(f => line.includes(f));
          });

          if (relevantIssues.length > 0) {
            const summary = relevantIssues.slice(0, 10).join('\n');
            return {
              passed: true, // Warning only, don't block
              output: `${relevantIssues.length} unused export(s) in modified files:\n${summary}`,
            };
          }

          return { passed: true, output: 'No dead code in modified files' };
        } catch {
          return { passed: true, output: 'Dead code detection not available' };
        }
      },
    },
  ],
};

export default plugin;
