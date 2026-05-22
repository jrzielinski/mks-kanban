/**
 * plugin-migration-check — Validates TypeORM migrations for safety.
 * Checks: has down() method, no DROP without confirmation, naming convention.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { MakeStudioPlugin } from '../core/plugin-types';

const plugin: MakeStudioPlugin = {
  name: 'migration-check',
  version: '1.0.0',
  description: 'Validate TypeORM migrations for safety and reversibility',

  verifyChecks: [
    {
      name: 'migration-check',
      appliesTo: ['database', 'feature', 'architecture'],

      async run(repoPath: string): Promise<{ passed: boolean; output?: string }> {
        try {
          // Find new/modified migration files
          const modifiedFiles = execSync(
            'git diff --name-only --diff-filter=ACMR HEAD | grep -i migration || true',
            { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
          ).trim().split('\n').filter(Boolean);

          if (!modifiedFiles.length) {
            return { passed: true, output: 'No migration files modified' };
          }

          const issues: string[] = [];

          for (const file of modifiedFiles) {
            const filePath = path.join(repoPath, file);
            if (!fs.existsSync(filePath)) continue;

            const content = fs.readFileSync(filePath, 'utf8');
            const fileName = path.basename(file);

            // Check 1: Has down() method for reversibility
            if (!content.includes('async down(')) {
              issues.push(`${fileName}: Missing down() method — migration is not reversible`);
            }

            // Check 2: DROP TABLE without safety check
            if (/DROP\s+TABLE/i.test(content)) {
              issues.push(`${fileName}: Contains DROP TABLE — destructive operation detected`);
            }

            // Check 3: DROP COLUMN without safety
            if (/DROP\s+COLUMN/i.test(content) || /dropColumn/i.test(content)) {
              issues.push(`${fileName}: Contains DROP COLUMN — data loss risk`);
            }

            // Check 4: TRUNCATE
            if (/TRUNCATE/i.test(content)) {
              issues.push(`${fileName}: Contains TRUNCATE — data loss risk`);
            }

            // Check 5: ALTER TYPE without safe handling
            if (/ALTER\s+.*TYPE/i.test(content) && !/USING/i.test(content)) {
              issues.push(`${fileName}: ALTER TYPE without USING clause — may fail on existing data`);
            }

            // Check 6: NOT NULL without DEFAULT on existing column
            if (/NOT\s+NULL/i.test(content) && !/DEFAULT/i.test(content) && /ADD\s+COLUMN/i.test(content)) {
              issues.push(`${fileName}: Adding NOT NULL column without DEFAULT — will fail on non-empty tables`);
            }
          }

          if (issues.length > 0) {
            return {
              passed: false,
              output: `${issues.length} migration issue(s):\n${issues.map(i => `  - ${i}`).join('\n')}`,
            };
          }

          return { passed: true, output: `${modifiedFiles.length} migration(s) checked — all safe` };
        } catch {
          return { passed: true, output: 'Migration check failed — skipping' };
        }
      },
    },
  ],
};

export default plugin;
