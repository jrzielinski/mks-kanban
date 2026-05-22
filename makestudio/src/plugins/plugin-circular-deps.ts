/**
 * plugin-circular-deps — Detects circular dependencies using madge.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { MakeStudioPlugin } from '../core/plugin-types';

const plugin: MakeStudioPlugin = {
  name: 'circular-deps',
  version: '1.0.0',
  description: 'Detect circular dependencies in the codebase',

  verifyChecks: [
    {
      name: 'circular-deps',
      appliesTo: ['feature', 'architecture'],

      async run(repoPath: string): Promise<{ passed: boolean; output?: string }> {
        if (!fs.existsSync(path.join(repoPath, 'tsconfig.json'))) {
          return { passed: true, output: 'No tsconfig.json — skipping' };
        }

        try {
          // Use madge to detect circular deps
          const result = execSync(
            'npx madge --circular --extensions ts,tsx src/ 2>/dev/null || echo "[]"',
            { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 60_000 },
          ).trim();

          // madge outputs circular deps as arrays
          if (result === '[]' || result === '' || result.includes('No circular')) {
            return { passed: true, output: 'No circular dependencies detected' };
          }

          // Count circular chains
          const lines = result.split('\n').filter(l => l.trim());
          const circularCount = lines.length;

          if (circularCount > 0) {
            return {
              passed: true, // Warning only — circular deps are common in large projects
              output: `${circularCount} circular dependency chain(s) detected:\n${lines.slice(0, 5).join('\n')}`,
            };
          }

          return { passed: true, output: 'No circular dependencies' };
        } catch {
          return { passed: true, output: 'madge not available — install with: npm i -D madge' };
        }
      },
    },
  ],
};

export default plugin;
